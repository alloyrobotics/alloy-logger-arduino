// genscene.js - the trusted interpreter for GENSPEC v1 `scene_spec`.
//
// A generated demo never ships code. It ships one JSON document, and this module turns the
// `scene_spec` half of it into the same `buildScene(THREE, mount)` the four hand-written robots
// export, so viewer.js cannot tell a generated robot from a canned one.
//
//   buildSceneFromSpec(sceneSpec) -> buildScene(THREE, mount)
//   buildScene(THREE, mount)      -> { update(tSec, data), setHighlight(ref|null), dispose(),
//                                      cameraHome, cameraFocus() }
//
// `mount` is a THREE.Group parented at the world origin, not a DOM node: viewer.js owns the
// renderer, camera, lights, ground and blueprint grid. Everything here is scene graph.
//
// Trust model. The spec is model-emitted, so nothing in it is believed:
//   - unknown archetypes, kinds, axes and colours fall back to a safe default rather than throw,
//     because a visitor with a slightly-off def must still get a scene, not a blank panel
//   - every hard cap in GENSPEC section 4 is enforced HERE, silently, whatever the spec asked
//     for: 6 units, 40 parts per unit, 12 extra parts, 8 props, 24 bindings, sizes in
//     [0.01, 5] world units, and a 50k triangle budget the primitive tessellation backs off to fit
//   - part ids are exactly the ones part-tables.mjs publishes, because `bindings[].part` and
//     `findings[].highlight` are validated against that table before the def is ever sent. An id
//     that differs here is a highlight that silently does nothing in the visitor's browser.
//
// Performance contract: update() runs at 60fps inside viewer.js's rAF loop, so it allocates
// NOTHING. Waypoint tracks, spin integrals, materials and scratch vectors are all built once.

import { sampleAt, clamp, remap, mulberry32 } from './prng.js';

// ---------------------------------------------------------------------------
// caps and tables (mirror of part-tables.mjs, which the validator resolves against)
// ---------------------------------------------------------------------------

// REBASE POINT: part-tables.mjs is the shared source of these ids and lives beside the
// validator today. When it moves into the repo alongside these interpreters, delete the two
// tables below and import `archetypeParts` / `SCENE_CAPS` from it instead. Until then the ids
// here are a hand-checked copy and MUST NOT drift: the validator accepts a def on the strength
// of that table, and this module is what has to honour it.
export const SCENE_CAPS = {
  maxUnits: 6,
  maxProps: 8,
  maxPartsPerUnit: 40,
  maxExtraParts: 12,
  maxBindings: 24,
  minWaypoints: 2,
  maxWaypoints: 40,
  scaleMin: 0.3,
  scaleMax: 3,
  // 2 mm, not 10 mm: a 180 mm robot's marker discs, kicker plates and PCB stacks are 2-8 mm and
  // a 10 mm floor renders every one of them at 5x its stated thickness. part-tables.mjs carries
  // the same number and the two MUST stay equal.
  sizeMin: 0.002,
  sizeMax: 5,
  /** Total triangles across units, props and the environment. */
  maxTriangles: 50000,
};

const WHEEL_IDS = {
  2: ['wheel_l', 'wheel_r'],
  4: ['wheel_fl', 'wheel_fr', 'wheel_bl', 'wheel_br'],
  6: ['wheel_fl', 'wheel_fr', 'wheel_ml', 'wheel_mr', 'wheel_bl', 'wheel_br'],
};

/**
 * A radial (holonomic) base numbers its wheels by their angle order instead of naming corners,
 * because "front-left" means nothing on a wheel mounted at 135 degrees. 3 | 4 | 6 wheels.
 */
function radialWheelIds(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`wheel_${i}`);
  return out;
}

/** Default yaw of each wheel about the chassis centre, degrees, 0 = straight ahead (+z). */
const RADIAL_ANGLES = {
  3: [0, 120, 240],
  4: [33, -33, 135, -135],
  6: [30, -30, 90, -90, 150, -150],
};

/** The wheel-id list for a wheeled unit's params, honouring layout and count. */
function wheelIdsFor(p) {
  const wheels = pick(p.wheels, [2, 3, 4, 6], 4);
  const radial = p.wheel_layout === 'radial' || wheels === 3;
  if (radial) return radialWheelIds(wheels);
  return WHEEL_IDS[wheels];
}

const LEG_IDS = {
  4: ['leg_fl', 'leg_fr', 'leg_bl', 'leg_br'],
  6: ['leg_fl', 'leg_fr', 'leg_ml', 'leg_mr', 'leg_bl', 'leg_br'],
};

/** Brand palette, straight off demo/DESIGN.md's token block. */
const BRAND = {
  canvas: 0x111111,
  card: 0x181818,
  elev: 0x1e1e1e,
  blue: 0x025dfe,
  blueHi: 0x2f78ff,
  sage: 0xd3eeb6,
  alert: 0xff5f57,
  warn: 0xf5a623,
  metal: 0x1b1e24,
  alu: 0x9aa3ad,
  rubber: 0x0b0c0d,
  line: 0xf2f4f8,
};

/**
 * Tessellation tiers. A busy fleet scene drops to a coarser tier so the whole scene stays
 * inside the triangle budget; a single hero robot gets the round one.
 */
const TIERS = [
  { cyl: 20, sphW: 16, sphH: 12, torR: 10, torT: 20, capC: 6, capR: 10 },
  { cyl: 14, sphW: 12, sphH: 8, torR: 8, torT: 16, capC: 4, capR: 7 },
  { cyl: 8, sphW: 8, sphH: 6, torR: 6, torT: 10, capC: 3, capR: 5 },
];

const AXES = { x: 'x', y: 'y', z: 'z' };

/** Shapes an extra_part or a prop may be. `cone` is what a sensor beam or a funnel needs. */
const PRIMITIVE_KINDS = ['box', 'cylinder', 'sphere', 'torus', 'capsule', 'cone'];

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

/** A finite number, or `fallback`. */
function nOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** A world dimension, always inside GENSPEC's [0.01, 5]. */
function size(v, fallback) {
  return clamp(nOr(v, fallback), SCENE_CAPS.sizeMin, SCENE_CAPS.sizeMax);
}

/** One of `allowed`, or `fallback`. */
function pick(v, allowed, fallback) {
  return allowed.indexOf(v) >= 0 ? v : fallback;
}

function axisOf(v, fallback) {
  return AXES[v] || fallback;
}

/** `#rrggbb` to a 24-bit int, or `fallback`. Anything malformed is simply not believed. */
function colorOf(v, fallback) {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) return fallback;
  return parseInt(v.slice(1), 16);
}

/**
 * A rectangular chassis is treated as the disc through its own footprint corners, shrunk a tenth.
 * The full half-diagonal would hold two robots apart by the width of their corners even when they
 * are meeting face to face, which reads as a magnetic repulsion; 0.9 lands the contact roughly on
 * the hull for the head-on case and still keeps the corners out of each other.
 */
const BOX_DISC = 0.9;

/**
 * Vertical dynamics budget (D6), as a fraction of the unit's OWN body height.
 *
 * A rigid rover on carpet - an omni soccer robot, a warehouse AMR - barely moves vertically at
 * all: the whole lean-plus-bob excursion is a rounding error against its own height. The first
 * pass wrote the lean gains and the bob amplitude as absolute constants in metres and radians,
 * tuned by eye on a metre-scale rover, which made a 180 mm RCJ robot and a 600 mm rover bob by
 * completely different fractions of themselves - measured 3.9 percent of body height on the
 * fixture rover, which reads as a hovercraft. Everything below is therefore stated as a fraction
 * of the unit and the unit is the only length that appears.
 *
 * VERT_FRAC is the TOTAL vertical excursion allowed, LEAN_SHARE is how much of it the lean is
 * allowed to spend (the rest is the rolling bob), and the maximum lean angles fall out of that
 * budget divided by the unit's own footprint, capped by the D6 angles so a tall narrow unit does
 * not lean further than the original clamps ever allowed.
 */
const VERT_FRAC = 0.012;
const LEAN_SHARE = 0.6;
const D6_ROLL_CLAMP = 0.12;
const D6_PITCH_CLAMP = 0.08;
/** Free-fall acceleration, the only honest way to make a lean gain scale-free. */
const GRAVITY = 9.81;

/**
 * Lean, bob and the accelerations that reach them, all derived from one unit's own dimensions.
 *
 * The lean is a fraction of the acceleration that would TIP the unit (g times footprint over CG
 * height), which is the one normalisation that makes an 18 cm robot and a 6 m truck lean by
 * comparable angles at comparable fractions of their own limits, instead of the small one leaning
 * like a motorbike because a constant gain was fitted at metre scale.
 */
function verticalDynamics(halfX, halfZ, bodyH) {
  const h = Math.max(bodyH, 1e-4);
  const budget = h * VERT_FRAC;
  const lean = budget * LEAN_SHARE * 0.5; // roll and pitch may both be at their limit at once
  const cg = Math.max(h * 0.5, 1e-4);
  const hx = Math.max(halfX, 1e-4);
  const hz = Math.max(halfZ, 1e-4);
  return {
    maxRoll: Math.min(D6_ROLL_CLAMP, Math.asin(clamp(lean / hx, 0, 1))),
    maxPitch: Math.min(D6_PITCH_CLAMP, Math.asin(clamp(lean / hz, 0, 1))),
    // the lateral / longitudinal acceleration at which this unit would go up on two wheels
    tipLat: (GRAVITY * hx) / cg,
    tipLong: (GRAVITY * hz) / cg,
    bobAmp: budget * (1 - LEAN_SHARE),
    // one bob per 1.2 body lengths, so the rhythm reads the same on a robot of any size
    bobK: (2 * Math.PI) / (1.2 * Math.max(hx + hz, 1e-3)),
  };
}

/**
 * Ground disc a unit occupies, in the SAME space as `node.position`.
 *
 * That space is root-LOCAL: `root.scale` carries worldScale, so every length inside the scene
 * graph - waypoints, `size()` params, the AABB halves measured at build time - is pre-scale, and
 * worldScale multiplies positions and radii together at draw time. Mixing a scaled radius into an
 * unscaled position is the one way to get this wrong, so nothing here is scaled.
 *
 * `halfX`/`halfZ` are the measured AABB halves, used only where an archetype states no chassis
 * footprint of its own.
 */
function collisionRadiusOf(archetype, p, halfX, halfZ) {
  let r;
  switch (archetype) {
    case 'wheeled':
      // A cylindrical hull IS a disc, so body_w/2 is exact rather than approximate - and it is
      // meaningfully tighter than the AABB, whose corners overhang the hull by 41 percent.
      r = pick(p.body_shape, ['box', 'cylinder'], 'box') === 'cylinder'
        ? size(p.body_w, 0.3) * 0.5
        : Math.hypot(size(p.body_len, 0.42), size(p.body_w, 0.3)) * 0.5 * BOX_DISC;
      break;
    case 'legged': {
      // The torso can be narrower than the stance, and it is the FEET that touch first.
      const stance = size(p.stance, 0.26);
      r = Math.hypot(size(p.body_len, 0.46), Math.max(size(p.body_w, stance * 0.9), stance)) * 0.5 * BOX_DISC;
      break;
    }
    case 'marine':
      r = Math.hypot(size(p.hull_len, 0.9), size(p.beam, 0.22)) * 0.5 * BOX_DISC;
      break;
    default:
      // arm, multirotor, and anything the part table grows later: no stated chassis footprint, so
      // what was actually built is the only honest source. A drone's disc is its rotor span.
      r = Math.hypot(halfX, halfZ) * BOX_DISC;
      break;
  }
  return Number.isFinite(r) && r > 1e-4 ? r : 1e-4;
}

/** Split `"/drive.vel"` into `{ path: "/drive", key: "vel" }`, or null. */
function splitField(ref) {
  if (typeof ref !== 'string') return null;
  const dot = ref.lastIndexOf('.');
  if (dot <= 0 || dot === ref.length - 1) return null;
  return { path: ref.slice(0, dot), key: ref.slice(dot + 1) };
}

/**
 * Part ids an archetype guarantees, excluding extra_parts. Byte-for-byte the ids
 * part-tables.mjs publishes, because the validator resolved the def against those.
 */
export function archetypeParts(archetype, params = {}) {
  const p = params || {};
  switch (archetype) {
    case 'wheeled': {
      const ids = wheelIdsFor(p);
      // Every wheel is a steer pivot parenting a roll pivot. `wheel_fl` keeps pointing at the ROLL
      // pivot so existing spin bindings resolve unchanged; `wheel_fl_steer` is the new one.
      const out = ['body', ...ids, ...ids.map((w) => `${w}_steer`)];
      if (p.mast === true) out.push('mast');
      return out;
    }
    case 'legged': {
      const legs = pick(p.legs, [4, 6], 4);
      const out = ['body', 'head'];
      for (const leg of LEG_IDS[legs]) out.push(leg, `${leg}_hip`, `${leg}_shin`);
      return out;
    }
    case 'arm': {
      const joints = pick(p.joints, [4, 5, 6], 6);
      const mount = pick(p.mount, ['floor', 'pedestal', 'gantry', 'wall'], p.pedestal === true ? 'pedestal' : 'floor');
      const out = ['base'];
      for (let i = 1; i <= joints; i++) out.push(`j${i}`);
      out.push('gripper');
      if (mount === 'pedestal') out.push('pedestal');
      if (mount === 'gantry') out.push('rail', 'carriage');
      return out;
    }
    case 'multirotor': {
      const rotors = pick(p.rotors, [4, 6, 8], 4);
      const out = ['body'];
      for (let i = 1; i <= rotors; i++) out.push(`arm${i}`);
      for (let i = 1; i <= rotors; i++) out.push(`rotor${i}`);
      out.push('skid_l', 'skid_r');
      return out;
    }
    case 'marine': {
      const out = ['hull', 'prop_l', 'prop_r', 'fin', 'mast'];
      if (p.sub === true) out.push('ballast', 'dive_plane_l', 'dive_plane_r');
      return out;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// motion tracks (built once, evaluated with zero allocation)
// ---------------------------------------------------------------------------

/**
 * Catmull-Rom through the waypoint at `i` and its neighbours, with the incoming and outgoing
 * tangents rescaled for NON-UNIFORM knots (`k0`, `k1` are the two tangent scale factors).
 *
 * The uniform form assumes every segment lasts the same time. Waypoint lists never do - a def
 * routinely mixes a 1.8 s dash with a 9.6 s cruise - and feeding uniform tangents to unequal
 * knots makes the curve surge into the short segment and sag out of the long one, which is
 * speed the data never asked for. Endpoints are still duplicated, so the curve passes through
 * the first and last points instead of overshooting off the field.
 */
function catmull(p0, p1, p2, p3, u, k0, k1) {
  const m0 = (p2 - p0) * k0;
  const m1 = (p3 - p1) * k1;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m1
  );
}

/** How many sub-samples per waypoint segment the arc-length table carries. */
const ARC_STEPS = 12;

/**
 * Cumulative arc length along a compiled waypoint track, built once at compile time.
 *
 * Everything that has to look like it is rolling on the ground - a ball's spin, a wheel's roll -
 * is a function of DISTANCE TRAVELLED, not of a telemetry channel and not of a per-frame delta.
 * Sampling the same table every frame makes the result absolute: scrubbing backwards unwinds a
 * wheel to exactly where it was, which a per-frame increment can never do.
 */
function buildArcTable(m) {
  const steps = (m.n - 1) * ARC_STEPS;
  const at = new Float64Array(steps + 1);
  const av = new Float64Array(steps + 1);
  const p = { x: 0, z: 0 };
  const t0 = m.ts[0];
  const t1 = m.ts[m.n - 1];
  let acc = 0;
  let px = 0;
  let pz = 0;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    waypointAt(m, t, p);
    if (i > 0) {
      const dx = p.x - px;
      const dz = p.z - pz;
      acc += Math.sqrt(dx * dx + dz * dz);
    }
    px = p.x;
    pz = p.z;
    at[i] = t;
    av[i] = acc;
  }
  m.arcT = at;
  m.arcV = av;
  m.arcTotal = acc;
}

/**
 * Distance travelled by `tSec`. Outside the track it extrapolates linearly off the end tangent so
 * a unit parked past its last waypoint does not have its wheels snap back to zero.
 */
function arcAt(m, tSec) {
  if (!m.arcT) return 0;
  let t = tSec;
  const span = m.ts[m.n - 1] - m.ts[0];
  let laps = 0;
  if (m.loop && span > 1e-9) {
    laps = Math.floor((t - m.ts[0]) / span);
    t = m.ts[0] + (((t - m.ts[0]) % span) + span) % span;
  }
  return laps * m.arcTotal + sampleAt(m.arcT, m.arcV, t);
}

/**
 * How a waypoint mover chooses its heading (G3). Holonomic robots strafe: an omni base keeps its
 * kicker face on the ball while it crabs sideways, and forcing yaw onto the travel direction is
 * the single loudest "this is a differential-drive animation" tell.
 */
function compileYaw(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { yawKind: 'fixed', yawVal: v };
  if (typeof v === 'string') {
    if (v.startsWith('face:')) {
      const ref = v.slice(5);
      if (ref) return { yawKind: 'face', yawRef: ref, yawNode: null };
    }
    const f = splitField(v);
    if (f) return { yawKind: 'channel', yawField: f };
  }
  return { yawKind: 'travel' };
}

/**
 * Compile a `motion` block into something update() can evaluate without touching the spec again.
 * Unknown or malformed motion degrades to a static unit at the origin, never to a throw.
 */
function compileMotion(motion) {
  const m = motion && typeof motion === 'object' ? motion : {};
  const kind = pick(m.kind, ['waypoints', 'channels', 'static'], 'static');

  if (kind === 'waypoints' && Array.isArray(m.points) && m.points.length >= SCENE_CAPS.minWaypoints) {
    const pts = m.points
      .slice(0, SCENE_CAPS.maxWaypoints)
      .filter((p) => Array.isArray(p) && p.length >= 3)
      .map((p) => ({ x: nOr(p[0], 0), z: nOr(p[1], 0), t: nOr(p[2], 0) }))
      .sort((a, b) => a.t - b.t);
    if (pts.length >= 2) {
      const n = pts.length;
      const ts = new Float64Array(n);
      const xs = new Float64Array(n);
      const zs = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        // A repeated timestamp would make the segment parameter divide by zero, so nudge it.
        ts[i] = i > 0 && pts[i].t <= ts[i - 1] ? ts[i - 1] + 1e-4 : pts[i].t;
        xs[i] = pts[i].x;
        zs[i] = pts[i].z;
      }
      const out = { kind: 'waypoints', loop: m.loop === true, n, ts, xs, zs, ...compileYaw(m.yaw) };
      buildArcTable(out);
      return out;
    }
  }

  if (kind === 'channels') {
    return {
      kind: 'channels',
      x: splitField(m.x),
      z: splitField(m.z),
      yaw: splitField(m.yaw),
    };
  }

  const pos = Array.isArray(m.pos) ? m.pos : [];
  return { kind: 'static', x: nOr(pos[0], 0), y: nOr(pos[1], 0), z: nOr(pos[2], 0), yaw: nOr(m.yaw, 0) };
}

/** Position of a waypoint track at `tSec`, written into `out`. */
function waypointAt(m, tSec, out) {
  const { ts, xs, zs, n } = m;
  let t = tSec;
  const span = ts[n - 1] - ts[0];
  if (m.loop && span > 1e-9) t = ts[0] + (((t - ts[0]) % span) + span) % span;
  if (t <= ts[0]) {
    out.x = xs[0];
    out.z = zs[0];
    return;
  }
  if (t >= ts[n - 1]) {
    out.x = xs[n - 1];
    out.z = zs[n - 1];
    return;
  }
  let i = 0;
  while (i < n - 2 && ts[i + 1] <= t) i++;
  const dt = ts[i + 1] - ts[i];
  const u = (t - ts[i]) / dt;
  const a = i > 0 ? i - 1 : 0;
  const d = i + 2 < n ? i + 2 : n - 1;
  // Non-uniform tangent scaling: each end tangent spans the knots either side of it, so it is
  // rescaled by this segment's share of that span. Duplicated endpoints give a span of one
  // segment, which is exactly the uniform case.
  const k0 = dt / (ts[i + 1] - ts[a] || dt);
  const k1 = dt / (ts[d] - ts[i] || dt);
  out.x = catmull(xs[a], xs[i], xs[i + 1], xs[d], u, k0, k1);
  out.z = catmull(zs[a], zs[i], zs[i + 1], zs[d], u, k0, k1);
}

// ---------------------------------------------------------------------------
// procedural textures
// ---------------------------------------------------------------------------
// Everything painted on the ground is rasterised into a DataTexture rather than drawn onto a
// 2D canvas. Two reasons, both hard: the fixture harness runs in Node where there is no
// `document`, and a DataTexture is a pure function of the numbers, so the same def produces the
// same bytes on every machine - the determinism guarantee the facts pack depends on.

/** A W x H RGBA byte raster with an ARGB-int fill helper set, in field metres. */
function raster(w, h, spanX, spanZ) {
  const data = new Uint8Array(w * h * 4);
  const R = {
    w,
    h,
    data,
    /** metres -> texel, x across the short axis, z along the long one */
    tx: (x) => ((x / spanX) + 0.5) * w,
    tz: (z) => ((z / spanZ) + 0.5) * h,
    mx: spanX / w,
    mz: spanZ / h,
  };
  return R;
}

function rasterFill(R, rgb, a) {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const d = R.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a == null ? 255 : a;
  }
}

/**
 * Stroke or fill a shape by testing every texel inside its bounding box against `sdf`, a signed
 * distance in metres. Bounded to the shape's own box, so a 20 mm line on a 2 m field touches a
 * few thousand texels rather than the whole million.
 */
function rasterShape(R, x0, z0, x1, z1, sdf, rgb, width) {
  const half = width * 0.5;
  const iu0 = Math.max(0, Math.floor(R.tx(x0 - width)));
  const iu1 = Math.min(R.w - 1, Math.ceil(R.tx(x1 + width)));
  const iv0 = Math.max(0, Math.floor(R.tz(z0 - width)));
  const iv1 = Math.min(R.h - 1, Math.ceil(R.tz(z1 + width)));
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const d = R.data;
  const spanX = R.mx * R.w;
  const spanZ = R.mz * R.h;
  for (let iv = iv0; iv <= iv1; iv++) {
    const z = ((iv + 0.5) / R.h - 0.5) * spanZ;
    for (let iu = iu0; iu <= iu1; iu++) {
      const x = ((iu + 0.5) / R.w - 0.5) * spanX;
      const s = sdf(x, z);
      if (s > half) continue;
      // one-texel feather so a line does not alias into a dashed stagger under anisotropy
      const cov = s <= half - R.mx ? 1 : clamp((half - s) / R.mx, 0, 1);
      const i = (iv * R.w + iu) * 4;
      d[i] = d[i] + (r - d[i]) * cov;
      d[i + 1] = d[i + 1] + (g - d[i + 1]) * cov;
      d[i + 2] = d[i + 2] + (b - d[i + 2]) * cov;
    }
  }
}

/** Outline of an axis-aligned rectangle, optionally with rounded corners (radius in metres). */
function rasterRect(R, cx, cz, hx, hz, radius, rgb, width) {
  const rr = clamp(radius, 0, Math.min(hx, hz));
  const ix = hx - rr;
  const iz = hz - rr;
  rasterShape(
    R,
    cx - hx,
    cz - hz,
    cx + hx,
    cz + hz,
    (x, z) => {
      const dx = Math.abs(x - cx) - ix;
      const dz = Math.abs(z - cz) - iz;
      const ox = dx > 0 ? dx : 0;
      const oz = dz > 0 ? dz : 0;
      const outside = Math.sqrt(ox * ox + oz * oz);
      const inside = Math.min(Math.max(dx, dz), 0);
      return Math.abs(outside + inside - rr);
    },
    rgb,
    width,
  );
}

/** A straight run of line between two points on the ground. */
function rasterLine(R, x0, z0, x1, z1, rgb, width) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len2 = dx * dx + dz * dz || 1;
  rasterShape(
    R,
    Math.min(x0, x1),
    Math.min(z0, z1),
    Math.max(x0, x1),
    Math.max(z0, z1),
    (x, z) => {
      const t = clamp(((x - x0) * dx + (z - z0) * dz) / len2, 0, 1);
      const px = x - (x0 + dx * t);
      const pz = z - (z0 + dz * t);
      return Math.sqrt(px * px + pz * pz);
    },
    rgb,
    width,
  );
}

/** A ring (width > 0) or a filled dot (pass width >= 2 * radius). */
function rasterCircle(R, cx, cz, radius, rgb, width) {
  rasterShape(
    R,
    cx - radius,
    cz - radius,
    cx + radius,
    cz + radius,
    (x, z) => Math.abs(Math.hypot(x - cx, z - cz) - radius),
    rgb,
    width,
  );
}

/** The short arc between two angles, x = cx + r cos(theta), z = cz + r sin(theta). */
function rasterArc(R, cx, cz, radius, a0, a1, rgb, width) {
  const TAU = Math.PI * 2;
  let delta = ((a1 - a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const mid = a0 + delta * 0.5;
  const halfSpan = Math.abs(delta) * 0.5;
  rasterShape(
    R,
    cx - radius,
    cz - radius,
    cx + radius,
    cz + radius,
    (x, z) => {
      const a = Math.atan2(z - cz, x - cx);
      let d = ((a - mid + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (Math.abs(d) > halfSpan) return 1e9;
      return Math.abs(Math.hypot(x - cx, z - cz) - radius);
    },
    rgb,
    width,
  );
}

/** Blend two packed rgb colours, `t` = 0 keeps `a`. */
function mixHex(a, b, t) {
  const k = clamp(t, 0, 1);
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const c = Math.round((a & 255) + ((b & 255) - (a & 255)) * k);
  return (r << 16) | (g << 8) | c;
}

/** Read a compiled field ref out of the built telemetry, with a default when it is absent. */
function readField(data, ref, tSec, fallback) {
  if (!ref || !data) return fallback;
  const ch = data[ref.path];
  if (!ch || !ch.t) return fallback;
  const arr = ch[ref.key];
  if (!arr) return fallback;
  return sampleAt(ch.t, arr, tSec);
}

// ---------------------------------------------------------------------------
// the interpreter
// ---------------------------------------------------------------------------

/**
 * @param {object} sceneSpec a GENSPEC v1 `scene_spec`
 * @returns {(THREE: object, mount: object) => object} a RobotDefinition-shaped buildScene
 */
export function buildSceneFromSpec(sceneSpec) {
  const spec = sceneSpec && typeof sceneSpec === 'object' ? sceneSpec : {};
  const units = (Array.isArray(spec.units) ? spec.units : []).slice(0, SCENE_CAPS.maxUnits);
  const props = (Array.isArray(spec.props) ? spec.props : []).slice(0, SCENE_CAPS.maxProps);
  const bindings = (Array.isArray(spec.bindings) ? spec.bindings : []).slice(0, SCENE_CAPS.maxBindings);
  const environment = pick(spec.environment, ['grid', 'field', 'warehouse', 'water', 'rubble'], 'grid');
  const worldScale = clamp(nOr(spec.scale, 1), SCENE_CAPS.scaleMin, SCENE_CAPS.scaleMax);

  // Tessellation tier off the part census. The exact triangle tally is measured while building
  // (below); this pre-pass only has to be conservative enough that the tally lands under budget.
  let partCensus = props.length;
  for (const u of units) {
    partCensus += archetypeParts(u && u.archetype, u && u.params).length;
    partCensus += Math.min((u && Array.isArray(u.extra_parts) ? u.extra_parts.length : 0), SCENE_CAPS.maxExtraParts);
  }
  const tier = partCensus <= 60 ? TIERS[0] : partCensus <= 140 ? TIERS[1] : TIERS[2];

  return function buildScene(THREE, mount) {
    const root = new THREE.Group();
    root.name = 'gen-root';
    root.scale.setScalar(worldScale);
    mount.add(root);

    // ---- bookkeeping every disposal path walks ----
    const geoms = [];
    const mats = [];
    const textures = [];

    /** Register a geometry for disposal and hand it back. */
    const geo = (g) => {
      geoms.push(g);
      return g;
    };
    const mat = (opts) => {
      const m = new THREE.MeshStandardMaterial(opts);
      mats.push(m);
      return m;
    };

    // Shared primitive factories, all tier-aware so the budget is one dial.
    const boxGeo = (x, y, z) => geo(new THREE.BoxGeometry(x, y, z));
    const cylGeo = (rt, rb, h) => geo(new THREE.CylinderGeometry(rt, rb, h, tier.cyl));
    const sphGeo = (r) => geo(new THREE.SphereGeometry(r, tier.sphW, tier.sphH));
    const torGeo = (r, tube) => geo(new THREE.TorusGeometry(r, tube, tier.torR, tier.torT));
    const capGeo = (r, h) => geo(new THREE.CapsuleGeometry(r, h, tier.capC, tier.capR));

    /**
     * parts: "<unitId>.<partId>" (and bare prop ids) -> { node, meshes }.
     * `node` is a pivot Group every transform binding writes to; `meshes` are what glow and
     * highlight repaint. Splitting the two is what lets a wheel spin about its own axle while
     * the mesh inside it keeps whatever orientation the primitive needed.
     */
    const parts = new Map();

    function addPart(key, node, meshes) {
      parts.set(key, { node, meshes: meshes || [] });
      return node;
    }

    /** A mesh inside a fresh pivot, the shape every archetype part takes. */
    function pivotMesh(parent, key, g, material, px, py, pz, mx, my, mz) {
      const pivot = new THREE.Group();
      pivot.position.set(px, py, pz);
      parent.add(pivot);
      const mesh = new THREE.Mesh(g, material);
      mesh.position.set(mx || 0, my || 0, mz || 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pivot.add(mesh);
      if (key) addPart(key, pivot, [mesh]);
      return pivot;
    }

    // ---------------------------------------------------------------- environment
    // y = 0 is THE contact plane: wheels, feet, hulls, balls, walls and goals all touch it.
    // Painted markings are a texture on the one floor plane rather than extruded slabs, so
    // nothing can slice a wheel, and the floor sits 2 mm BELOW zero with a polygon offset so it
    // still wins the depth test without ever poking through what is resting on it.
    const envUpdaters = [];
    const FLOOR_Y = -0.002 / worldScale;
    const SURROUND_Y = -0.02 / worldScale;
    /** Colour the fog and the surround take, so the horizon dissolves instead of ending. */
    let horizonColor = 0x14161a;
    const fogColorOf = () => mixHex(horizonColor, 0x0b0c0e, 0.45);

    const ep = spec.environment_params && typeof spec.environment_params === 'object' ? spec.environment_params : null;
    /** [length_z, width_x] of the marked playing area, metres. */
    const envSize = (() => {
      const s = ep && Array.isArray(ep.size) ? ep.size : null;
      const dz = s ? clamp(nOr(s[0], 18), 0.5, 120) : null;
      const dx = s ? clamp(nOr(s[1], 12), 0.5, 120) : null;
      return { z: dz, x: dx };
    })();

    /** Upload a raster as an sRGB texture, registered for disposal. */
    function dataTex(R) {
      const t = new THREE.DataTexture(R.data, R.w, R.h, THREE.RGBAFormat);
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
      t.needsUpdate = true;
      textures.push(t);
      return t;
    }

    /**
     * A pitch, an arena or a court, from the six rulebook numbers a model already knows.
     *
     * `environment_params` is optional and every number below falls back to the 18 x 12 m layout
     * this environment has always drawn, so a def that says nothing renders what it always did.
     * `size` is the MARKED playing area (boundary line included); walls and their outer band sit
     * outside it, which is how every rulebook states a field.
     */
    function buildField(floor, surround, slab) {
      const lenZ = envSize.z || 18;
      const widX = envSize.x || 12;
      const halfZ = lenZ * 0.5;
      const halfX = widX * 0.5;
      const short = Math.min(lenZ, widX);
      // Line width tracks the field, because a 60 mm stroke is a third of a robot on a 1.6 m
      // arena and invisible on a full pitch. 1.58 m -> 20 mm (RCJ), 12 m -> 72 mm, 68 m -> 120 mm.
      const lineW = clamp(short * 0.005 + 0.012, 0.008, 0.12);
      const markings = pick(ep && ep.markings, ['soccer', 'none'], 'soccer');
      const floorColor = colorOf(ep && ep.floor_color, 0x1b3a26);
      const lineColor = colorOf(ep && ep.line_color, BRAND.line);
      // `center_circle` is the RADIUS. Explicit null is "this arena has no centre circle", which
      // is a different statement from an absent key, which means "whatever this field usually has".
      const circleR = ep && ep.center_circle === null
        ? 0
        : ep && Number.isFinite(ep.center_circle)
          ? clamp(ep.center_circle, 0.05, short * 0.45)
          : short * 0.183;
      // Same null-vs-absent split for the penalty area, and `corner_r` is the only key that has a
      // fallback rather than a default: see the heuristic below.
      const pen = ep && ep.penalty_area !== undefined && ep.penalty_area !== null
        && typeof ep.penalty_area === 'object' ? ep.penalty_area : null;
      const hasPen = !(ep && ep.penalty_area === null);
      const areaW = pen ? clamp(nOr(pen.width, 5), 0.1, widX) : widX * 0.417;
      const areaD = pen ? clamp(nOr(pen.depth, 1.5), 0.05, halfZ) : lenZ * 0.083;
      const walls = ep && ep.walls && typeof ep.walls === 'object' ? ep.walls : null;
      const wallH = walls ? clamp(nOr(walls.height, 0.22), 0, 3) : 0;
      // The band of floor between the boundary line and the wall. RCJ calls it the outer area and
      // states it at 12 cm; a def that omits it gets a wall on the line, which is also legal.
      const band = walls ? clamp(nOr(walls.band, 0), 0, short) : 0;
      const goal = ep && ep.goal && typeof ep.goal === 'object' ? ep.goal : null;
      const goalColors = ep && Array.isArray(ep.goal_colors) ? ep.goal_colors : [];

      horizonColor = floorColor;
      surround();

      const floorX = widX + band * 2;
      const floorZ = lenZ + band * 2;
      const R = raster(1024, 1024, floorX, floorZ);
      rasterFill(R, floorColor);
      if (markings === 'soccer') {
        // `penalty_area.corner_r` states the front-corner radius outright. When the def is silent
        // the heuristic stands in: junior arenas mark their penalty areas with rounded fronts, a
        // full-size pitch squares them off, and the field's own scale is the only signal available.
        const corner = pen && Number.isFinite(pen.corner_r)
          ? clamp(pen.corner_r, 0, Math.min(areaD, areaW * 0.5))
          : lenZ <= 4 ? Math.min(areaD * 0.6, areaW * 0.25) : 0;
        rasterRect(R, 0, 0, halfX, halfZ, 0, lineColor, lineW);
        rasterLine(R, -halfX, 0, halfX, 0, lineColor, lineW);
        if (circleR > 0) rasterCircle(R, 0, 0, circleR, lineColor, lineW);
        rasterCircle(R, 0, 0, lineW, lineColor, lineW * 2);
        for (const sgn of hasPen ? [1, -1] : []) {
          // Three sides only: the penalty area is open on the goal line, and its front corners
          // are arcs rather than a rounded rectangle's four.
          const zf = sgn * (halfZ - areaD);
          const ax = areaW * 0.5;
          rasterLine(R, -ax + corner, zf, ax - corner, zf, lineColor, lineW);
          for (const sx of [-1, 1]) {
            rasterLine(R, sx * ax, sgn * halfZ, sx * ax, zf + sgn * corner, lineColor, lineW);
            if (corner > 0) {
              // quarter arc joining the side line to the front line
              rasterArc(R, sx * (ax - corner), zf + sgn * corner, corner,
                sx > 0 ? 0 : Math.PI, (-sgn * Math.PI) / 2, lineColor, lineW);
            }
          }
        }
      }
      floor(floorColor, floorX, floorZ, 0.97, dataTex(R));

      if (goal) {
        const gw = clamp(nOr(goal.width, 0.6), 0.1, widX);
        const gh = clamp(nOr(goal.height, 0.1), 0.02, 3);
        const gd = clamp(nOr(goal.depth, 0.074), 0.02, Math.max(band, 0.5));
        const post = clamp(gh * 0.12, 0.008, 0.05);
        // Yellow at one end and blue at the other is the rule in every league that has coloured
        // goals, so it is also the default: a def that states nothing still reads correctly.
        // `goal_colors` is stated [-z end, +z end], so it is indexed by the END, not by build
        // order: the loop builds +z first and reading the array positionally would swap the ends.
        const colors = [colorOf(goalColors[0], 0xf2c318), colorOf(goalColors[1], 0x2f78ff)];
        const sideGeo = boxGeo(post, gh, gd);
        const backGeo = boxGeo(gw + post * 2, gh, post);
        const barGeo = boxGeo(gw + post * 2, post, gd);
        for (let s = 0; s < 2; s++) {
          const sgn = s === 0 ? 1 : -1;
          const gm = mat({ color: colors[sgn > 0 ? 1 : 0], roughness: 0.9, metalness: 0.02 });
          const z0 = sgn * halfZ; // the mouth sits ON the boundary line, the box extends outward
          const zc = z0 + sgn * gd * 0.5;
          slab(sideGeo, gm, -(gw + post) * 0.5, gh * 0.5, zc);
          slab(sideGeo, gm, (gw + post) * 0.5, gh * 0.5, zc);
          slab(backGeo, gm, 0, gh * 0.5, z0 + sgn * (gd + post * 0.5));
          slab(barGeo, gm, 0, gh + post * 0.5, zc);
        }
      }

      // `walls.height` 0 is the explicit "no wall", so the band can still push the floor out to
      // the arena's real outer area on an open field.
      if (wallH > 0) {
        const wt = 0.02;
        const wm = mat({ color: colorOf(ep && ep.wall_color, 0x15161a), roughness: 0.98, metalness: 0.0 });
        const longGeo = boxGeo(wt, wallH, floorZ + wt * 2);
        const endGeo = boxGeo(floorX + wt * 2, wallH, wt);
        for (const sgn of [1, -1]) {
          slab(longGeo, wm, sgn * (floorX * 0.5 + wt * 0.5), wallH * 0.5, 0);
          slab(endGeo, wm, 0, wallH * 0.5, sgn * (floorZ * 0.5 + wt * 0.5));
        }
      }
    }

    function buildEnvironment() {
      /**
       * The far floor. Without it the environment is a rectangle laid over a void with the
       * blueprint grid receding behind the seam, which is exactly what "a slab floating in
       * nothing" looks like from a low camera.
       */
      const surround = () => {
        const g = geo(new THREE.PlaneGeometry(90, 90));
        g.rotateX(-Math.PI / 2);
        // exactly the fog colour: any other value puts a visible seam where the floor ends, which
        // is what made the environment read as a slab laid over a void
        const m = new THREE.Mesh(g, mat({ color: fogColorOf(), roughness: 0.98, metalness: 0.0 }));
        m.position.y = SURROUND_Y;
        m.receiveShadow = true;
        root.add(m);
        return m;
      };
      const floor = (color, sizeX, sizeZ, roughness, map) => {
        const g = geo(new THREE.PlaneGeometry(sizeX, sizeZ));
        g.rotateX(-Math.PI / 2);
        const opts = {
          color: map ? 0xffffff : color,
          roughness: roughness == null ? 0.95 : roughness,
          metalness: 0.02,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        };
        if (map) opts.map = map;
        const m = new THREE.Mesh(g, mat(opts));
        m.position.y = FLOOR_Y;
        m.receiveShadow = true;
        root.add(m);
        return m;
      };
      const slab = (g, material, x, y, z, ry) => {
        const m = new THREE.Mesh(g, material);
        m.position.set(x, y, z);
        if (ry) m.rotation.y = ry;
        m.castShadow = true;
        m.receiveShadow = true;
        root.add(m);
        return m;
      };

      if (environment === 'grid') {
        // viewer.js already draws the blueprint grid, so all this adds is an origin ring: it
        // gives the eye a scale reference without competing with the robot.
        const ring = new THREE.Mesh(torGeo(1.2, 0.012), mat({ color: BRAND.blueHi, roughness: 0.4, emissive: BRAND.blue, emissiveIntensity: 0.5 }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.002 / worldScale;
        root.add(ring);
        return;
      }

      if (environment === 'field') {
        buildField(floor, surround, slab);
        return;
      }

      if (environment === 'warehouse') {
        horizonColor = 0x121316;
        surround();
        const uprightGeo = boxGeo(0.09, 2.6, 0.09);
        const shelfGeo = boxGeo(2.6, 0.06, 0.9);
        const rackMat = mat({ color: BRAND.metal, roughness: 0.5, metalness: 0.7 });
        const cartonMat = mat({ color: 0x6b5637, roughness: 0.94, metalness: 0.0 });
        const cartonGeo = boxGeo(0.5, 0.42, 0.5);
        for (const [rx, rz, ry] of [[-5.2, -2, 0], [-5.2, 3.4, 0], [5.2, -1, 0], [0, -7.2, Math.PI / 2]]) {
          for (const dx of [-1.25, 1.25]) {
            for (const dz of [-0.4, 0.4]) {
              const c = Math.cos(ry);
              const s = Math.sin(ry);
              slab(uprightGeo, rackMat, rx + dx * c + dz * s, 1.3, rz - dx * s + dz * c);
            }
          }
          for (const sy of [0.7, 1.55, 2.4]) slab(shelfGeo, rackMat, rx, sy, rz, ry);
          for (const dx of [-0.85, 0.05, 0.85]) {
            const c = Math.cos(ry);
            const s = Math.sin(ry);
            slab(cartonGeo, cartonMat, rx + dx * c, 1.79, rz - dx * s, ry);
          }
        }
        // two painted aisle stripes, the only warm lines in the shot. Painted, so they live in the
        // floor texture rather than as extruded slabs a wheel could sink into.
        const aisleR = raster(256, 256, envSize.x || 34, envSize.z || 34);
        rasterFill(aisleR, 0x1a1b1e);
        for (const sx of [-2.6, 2.6]) rasterLine(aisleR, sx, -11, sx, 11, BRAND.warn, 0.12);
        floor(0x1a1b1e, envSize.x || 34, envSize.z || 34, 0.9, dataTex(aisleR));
        return;
      }

      if (environment === 'water') {
        // A displaced plane rather than a flat one: a marine unit sitting on glass reads as a
        // render bug. 24 x 24 segments is 1152 triangles, which the budget can always afford.
        horizonColor = 0x0a1a26;
        const segs = 24;
        const span = Math.max(envSize.x || 36, envSize.z || 36, 36);
        const g = geo(new THREE.PlaneGeometry(span, span, segs, segs));
        g.rotateX(-Math.PI / 2);
        const surface = new THREE.Mesh(g, mat({ color: 0x0e2a3f, roughness: 0.24, metalness: 0.42 }));
        surface.position.y = FLOOR_Y;
        surface.receiveShadow = true;
        root.add(surface);
        const pos = g.attributes.position;
        const count = pos.count;
        const bx = new Float64Array(count);
        const bz = new Float64Array(count);
        for (let i = 0; i < count; i++) {
          bx[i] = pos.getX(i);
          bz[i] = pos.getZ(i);
        }
        envUpdaters.push((tSec) => {
          for (let i = 0; i < count; i++) {
            const h =
              Math.sin(bx[i] * 0.42 + tSec * 1.15) * 0.035 +
              Math.sin(bz[i] * 0.31 - tSec * 0.83) * 0.028 +
              Math.sin((bx[i] + bz[i]) * 0.17 + tSec * 0.5) * 0.02;
            pos.setY(i, h);
          }
          pos.needsUpdate = true;
          g.computeVertexNormals();
        });
        return;
      }

      // rubble
      horizonColor = 0x14100e;
      surround();
      floor(0x1c1917, envSize.x || 34, envSize.z || 34, 0.99);
      const rubbleMat = mat({ color: 0x2a2724, roughness: 0.97, metalness: 0.03 });
      const slabMat = mat({ color: 0x35302b, roughness: 0.95, metalness: 0.04 });
      // Deterministic scatter: a fixed mulberry32 stream, never Math.random, so the debris is in
      // the same place on every page load and on every machine.
      const rnd = mulberry32(0x5c4a11);
      const chunkGeos = [boxGeo(0.5, 0.34, 0.42), boxGeo(0.72, 0.22, 0.58), boxGeo(0.34, 0.5, 0.3)];
      for (let i = 0; i < 26; i++) {
        const a = rnd() * Math.PI * 2;
        const r = 2.2 + rnd() * 9;
        const g2 = chunkGeos[i % chunkGeos.length];
        const m = new THREE.Mesh(g2, i % 3 === 0 ? slabMat : rubbleMat);
        m.position.set(Math.cos(a) * r, 0.08 + rnd() * 0.14, Math.sin(a) * r);
        m.rotation.set((rnd() - 0.5) * 0.5, rnd() * Math.PI, (rnd() - 0.5) * 0.5);
        m.castShadow = true;
        m.receiveShadow = true;
        root.add(m);
      }
      // two collapsed slabs leaning on each other, so the debris field has a silhouette
      const leanGeo = boxGeo(2.4, 0.14, 1.6);
      for (const [x, z, rz] of [[-3.6, 2.4, 0.42], [-2.2, 2.9, -0.34]]) {
        const m = new THREE.Mesh(leanGeo, slabMat);
        m.position.set(x, 0.5, z);
        m.rotation.set(0.1, 0.6, rz);
        m.castShadow = true;
        m.receiveShadow = true;
        root.add(m);
      }
    }

    buildEnvironment();

    // ---------------------------------------------------------------- archetypes
    // Every builder works in a unit-local frame where forward is +z and right is +x, so
    // `rotation.y` is yaw and a wheel's axle is the x axis. Waypoint yaw depends on that.

    /**
     * Per-unit scratch the builders write back into: which pivots are wheels, how big they are,
     * and where the deck trim sits. applyMotion needs the first two to roll wheels off the path,
     * and buildExtraParts needs the third to stop a deck part passing through the trim.
     */
    let build = { wheels: [], wheelR: 0, trim: null };

    function unitMaterials(tint) {
      const body = mat({ color: tint, roughness: 0.44, metalness: 0.36 });
      const dark = mat({ color: BRAND.elev, roughness: 0.62, metalness: 0.3 });
      const metal = mat({ color: BRAND.metal, roughness: 0.36, metalness: 0.86 });
      const alu = mat({ color: BRAND.alu, roughness: 0.3, metalness: 0.92 });
      const rubber = mat({ color: BRAND.rubber, roughness: 0.96, metalness: 0.02 });
      const led = mat({ color: BRAND.sage, emissive: BRAND.sage, emissiveIntensity: 1.3, roughness: 0.4 });
      return { body, dark, metal, alu, rubber, led, tint };
    }

    function buildWheeled(unitRoot, id, p, M) {
      const wheels = pick(p.wheels, [2, 3, 4, 6], 4);
      const shape = pick(p.body_shape, ['box', 'cylinder'], 'box');
      const len = size(p.body_len, 0.42);
      const wid = size(p.body_w, 0.3);
      const hgt = size(p.body_h, 0.14);
      const wr = size(p.wheel_r, 0.08);
      // Ground clearance was hardcoded at 20 mm, which floats a 180 mm cylinder robot a quarter of
      // its own height off the carpet. Small holonomic bases run 3-8 mm.
      const clearance = clamp(nOr(p.clearance, 0.02), 0, 0.6);
      const deck = wr + hgt * 0.5 + clearance;

      let bodyGeo;
      if (shape === 'cylinder') {
        // A cylindrical chassis with a chord cut off the front face: the flat is the dribbler and
        // kicker face every small holonomic soccer robot has, and the wedge is left out of the
        // cylinder's theta range rather than booleaned away, then closed with one plate.
        const rad = wid * 0.5;
        const flat = clamp(nOr(p.front_flat, 0), 0, 0.45);
        if (flat > 0.001) {
          const halfAngle = Math.acos(clamp(1 - 2 * flat, -1, 1));
          bodyGeo = geo(new THREE.CylinderGeometry(rad, rad, hgt, tier.cyl, 1, false, halfAngle, Math.PI * 2 - halfAngle * 2));
        } else {
          bodyGeo = cylGeo(rad, rad, hgt);
        }
      } else {
        bodyGeo = boxGeo(wid, hgt, len);
      }
      const bodyPivot = pivotMesh(unitRoot, `${id}.body`, bodyGeo, M.body, 0, deck, 0);
      if (shape === 'cylinder') {
        const flat = clamp(nOr(p.front_flat, 0), 0, 0.45);
        if (flat > 0.001) {
          const rad = wid * 0.5;
          const chordZ = rad * (1 - 2 * flat);
          const chordW = 2 * rad * Math.sin(Math.acos(clamp(chordZ / rad, -1, 1)));
          // The omitted theta wedge leaves the solid open from the axis out to the chord, top and
          // bottom included, so closing it with a thin plate at the chord plane still shows a
          // black hole where the caps stop. The filler is the whole wedge: a box running from the
          // axis out to the chord, in the chassis colour, whose front face IS the flat.
          // a hair shorter than the hull, or its top and bottom faces are coplanar with the
          // cylinder's caps and the pair z-fight into a row of dark streaks
          const plate = new THREE.Mesh(boxGeo(chordW, hgt - 0.0008, Math.max(chordZ, 0.002)), M.body);
          plate.position.z = chordZ * 0.5;
          plate.castShadow = true;
          plate.receiveShadow = true;
          bodyPivot.add(plate);
          parts.get(`${id}.body`).meshes.push(plate);
        }
      }
      // A thin accent panel on the deck so the tint is not the only thing carrying the brand.
      // It takes the unit's OWN colour darkened, because a fixed brand blue on a yellow team robot
      // is the reading that broke team identity, and it sits 2 mm proud instead of 20 mm so
      // nothing an author puts on the deck can pass through it.
      const trimW = shape === 'cylinder' ? wid * 0.5 : wid * 0.62;
      const trimL = shape === 'cylinder' ? wid * 0.5 : len * 0.5;
      const trim = new THREE.Mesh(boxGeo(trimW, 0.002, trimL), mat({ color: mixHex(M.tint, 0x000000, 0.35), roughness: 0.34, metalness: 0.2, emissive: mixHex(M.tint, 0x000000, 0.55), emissiveIntensity: 0.5 }));
      trim.position.y = hgt * 0.5 + 0.001;
      trim.castShadow = true;
      bodyPivot.add(trim);
      parts.get(`${id}.body`).meshes.push(trim);
      build.trim = { x: trimW * 0.5, z: trimL * 0.5, y0: hgt * 0.5, y1: hgt * 0.5 + 0.002, host: bodyPivot };

      const ids = wheelIdsFor(p);
      const radial = p.wheel_layout === 'radial' || wheels === 3;
      const kind = pick(p.wheel_kind, ['tyre', 'omni', 'caster'], 'tyre');
      const inset = clamp(nOr(p.wheel_inset, 0), 0, 1);
      // outboard (today's placement) to fully tucked under the body
      const outX = wid * 0.5 + wr * 0.32;
      const inX = wid * 0.5 - wr * 0.34;
      const placements = [];
      if (radial) {
        const angles = Array.isArray(p.wheel_angles) && p.wheel_angles.length >= wheels
          ? p.wheel_angles.slice(0, wheels).map((a) => nOr(a, 0))
          : RADIAL_ANGLES[wheels] || RADIAL_ANGLES[4];
        // The axle points radially, so the wheel rolls tangentially - which is what makes a
        // holonomic base able to drive in any direction without turning.
        const ring = (shape === 'cylinder' ? wid * 0.5 : Math.min(wid, len) * 0.5) - wr * 0.55 * (0.4 + inset * 0.6);
        for (let i = 0; i < wheels; i++) {
          const th = (angles[i] * Math.PI) / 180;
          placements.push({ x: Math.sin(th) * ring, z: Math.cos(th) * ring, ry: th - Math.PI / 2 });
        }
      } else {
        const rows = wheels === 2 ? [0] : wheels === 4 ? [len * 0.34, -len * 0.34] : [len * 0.36, 0, -len * 0.36];
        for (const z of rows) {
          for (const sgnX of [-1, 1]) placements.push({ x: sgnX * (outX + (inX - outX) * inset), z, ry: 0 });
        }
      }

      const tyre = kind === 'tyre' ? cylGeo(wr, wr, wr * 0.55) : null;
      const hub = cylGeo(wr * (kind === 'omni' ? 0.66 : 0.34), wr * (kind === 'omni' ? 0.66 : 0.34), wr * (kind === 'omni' ? 0.42 : 0.62));
      // Rollers are 8-segment cylinders rather than capsules: at demo framing the silhouette is
      // identical and a capsule ring on six wheels would eat a fifth of the whole triangle budget.
      const roller = kind === 'omni' ? geo(new THREE.CylinderGeometry(wr * 0.17, wr * 0.17, wr * 0.44, 8)) : null;
      const casterBall = kind === 'caster' ? sphGeo(wr * 0.5) : null;
      for (let k = 0; k < ids.length && k < placements.length; k++) {
        const pl = placements[k];
        // Steer pivot parents the roll pivot. `wheel_fl` still IS the roll pivot, so every spin
        // binding written against the old tree resolves to the same node; a `rotate` on
        // `wheel_fl_steer` is a genuine steering angle instead of a second Euler term fighting a
        // roll integral that has wound up to tens of radians.
        const steer = new THREE.Group();
        steer.position.set(pl.x, wr, pl.z);
        steer.rotation.y = pl.ry;
        unitRoot.add(steer);
        const pivot = new THREE.Group();
        steer.add(pivot);
        const meshes = [];
        if (kind === 'tyre') {
          const t = new THREE.Mesh(tyre, M.rubber);
          t.rotation.z = Math.PI / 2; // axle along x, so a `spin` on axis x is the roll
          t.castShadow = true;
          t.receiveShadow = true;
          pivot.add(t);
          meshes.push(t);
        } else if (kind === 'caster') {
          const b = new THREE.Mesh(casterBall, M.rubber);
          b.castShadow = true;
          pivot.add(b);
          meshes.push(b);
        }
        const h = new THREE.Mesh(hub, M.alu);
        h.rotation.z = Math.PI / 2;
        h.castShadow = true;
        pivot.add(h);
        meshes.push(h);
        if (kind === 'omni') {
          for (let r = 0; r < 8; r++) {
            const ph = (r / 8) * Math.PI * 2;
            const rl = new THREE.Mesh(roller, M.rubber);
            // 0.79 rather than 0.83: the roller is a box-bounded cylinder, so its CORNER is what
            // reaches furthest from the hub, and at 0.83 that corner dipped 4 mm through the floor
            rl.position.set(0, Math.cos(ph) * wr * 0.79, Math.sin(ph) * wr * 0.79);
            rl.rotation.x = ph + Math.PI / 2; // roller axis tangent to the rim
            rl.castShadow = true;
            pivot.add(rl);
            meshes.push(rl);
          }
        } else if (kind === 'tyre') {
          const spoke = new THREE.Mesh(boxGeo(wr * 0.6, wr * 1.5, 0.012), M.metal);
          spoke.rotation.y = Math.PI / 2;
          pivot.add(spoke);
          meshes.push(spoke);
        }
        addPart(`${id}.${ids[k]}_steer`, steer, meshes);
        addPart(`${id}.${ids[k]}`, pivot, meshes);
        build.wheels.push(pivot);
      }
      build.wheelR = wr;

      if (p.mast === true) {
        const mastH = size(p.mast_h, 0.34);
        const mastPivot = pivotMesh(unitRoot, `${id}.mast`, cylGeo(0.018, 0.022, mastH), M.alu, 0, deck + hgt * 0.5, -len * 0.18, 0, mastH * 0.5, 0);
        const head = new THREE.Mesh(cylGeo(0.05, 0.05, 0.04), M.dark);
        head.position.y = mastH + 0.02;
        head.castShadow = true;
        mastPivot.add(head);
        const eye = new THREE.Mesh(torGeo(0.048, 0.008), M.led);
        eye.rotation.x = Math.PI / 2;
        eye.position.y = mastH + 0.02;
        mastPivot.add(eye);
        parts.get(`${id}.mast`).meshes.push(head, eye);
      }
    }

    function buildLegged(unitRoot, id, p, M) {
      const legs = pick(p.legs, [4, 6], 4);
      const len = size(p.body_len, 0.46);
      const stance = size(p.stance, 0.26);
      const thigh = size(p.thigh, 0.2);
      const shin = size(p.shin, 0.22);
      // Body width was welded to stance, so widening a quadruped's footprint fattened its torso.
      const bodyW = size(p.body_w, stance * 0.9);
      const bodyH = size(p.body_h, 0.12);
      // A quadruped standing on dead-straight legs is a table. The default crouch is the rest
      // pose every legged robot actually holds, and it also lands the feet ON the ground: the old
      // deck of 0.7 * (thigh + shin) with straight legs buried them 120 mm under it.
      const crouch = clamp(nOr(p.crouch, 0.62), 0, 1.2);
      const splay = clamp(nOr(p.splay, 0), -0.9, 0.9);
      const footR = 0.036;
      const deck = (thigh + shin) * Math.cos(crouch) * Math.cos(splay) + footR;

      pivotMesh(unitRoot, `${id}.body`, boxGeo(bodyW, bodyH, len), M.body, 0, deck, 0);
      const headPivot = pivotMesh(unitRoot, `${id}.head`, boxGeo(0.13, 0.1, 0.15), M.dark, 0, deck + 0.09, len * 0.44);
      const sensor = new THREE.Mesh(sphGeo(0.035), M.led);
      sensor.position.set(0, 0, 0.08);
      headPivot.add(sensor);
      parts.get(`${id}.head`).meshes.push(sensor);

      const ids = LEG_IDS[legs];
      const rows = legs === 4 ? [len * 0.32, -len * 0.32] : [len * 0.36, 0, -len * 0.36];
      const hipGeo = sphGeo(0.045);
      const thighGeo = capGeo(0.032, thigh);
      const shinGeo = capGeo(0.024, shin);
      const footGeo = sphGeo(footR);
      let k = 0;
      for (const z of rows) {
        for (const sgnX of [-1, 1]) {
          const legId = ids[k++];
          // leg_X is the attachment pivot, leg_X_hip swings the thigh, leg_X_shin the shin.
          const legPivot = new THREE.Group();
          // hips at deck height exactly, so the crouched leg chain plants the foot on y = 0
          legPivot.position.set(sgnX * stance * 0.5, deck, z);
          // splay rolls the whole leg outward, which is the difference between a mammal stance
          // and an insect one; `rotate` bindings still compose on top because they capture baseRot
          legPivot.rotation.z = -sgnX * splay;
          unitRoot.add(legPivot);
          const hipBall = new THREE.Mesh(hipGeo, M.metal);
          hipBall.castShadow = true;
          legPivot.add(hipBall);
          addPart(`${id}.${legId}`, legPivot, [hipBall]);

          const hipPivot = new THREE.Group();
          hipPivot.rotation.x = crouch;
          legPivot.add(hipPivot);
          const thighMesh = new THREE.Mesh(thighGeo, M.body);
          thighMesh.position.y = -thigh * 0.5;
          thighMesh.castShadow = true;
          hipPivot.add(thighMesh);
          addPart(`${id}.${legId}_hip`, hipPivot, [thighMesh]);

          const shinPivot = new THREE.Group();
          shinPivot.position.y = -thigh;
          shinPivot.rotation.x = -2 * crouch;
          hipPivot.add(shinPivot);
          const shinMesh = new THREE.Mesh(shinGeo, M.alu);
          shinMesh.position.y = -shin * 0.5;
          shinMesh.castShadow = true;
          shinPivot.add(shinMesh);
          const foot = new THREE.Mesh(footGeo, M.rubber);
          foot.position.y = -shin;
          foot.castShadow = true;
          shinPivot.add(foot);
          addPart(`${id}.${legId}_shin`, shinPivot, [shinMesh, foot]);
        }
      }
    }

    function buildArm(unitRoot, id, p, M) {
      const joints = pick(p.joints, [4, 5, 6], 6);
      const reach = size(p.reach, 0.9);
      const seg = reach / joints;
      const mount = pick(p.mount, ['floor', 'pedestal', 'gantry', 'wall'], p.pedestal === true ? 'pedestal' : 'floor');
      const mountH = clamp(nOr(p.mount_h, mount === 'gantry' ? reach * 1.35 : 0.3), 0.02, 6);

      if (mount === 'pedestal') {
        pivotMesh(unitRoot, `${id}.pedestal`, cylGeo(0.16, 0.2, mountH), M.dark, 0, 0, 0, 0, mountH * 0.5, 0);
      }
      // A gantry hangs its chain DOWN off a carriage that traverses an overhead rail, which is a
      // real logged axis: `offset` on axis x against a traverse channel drives it directly.
      let chainRoot = unitRoot;
      let chainDown = false;
      if (mount === 'gantry') {
        const span = clamp(nOr(p.span, reach * 2.4), 0.2, 24);
        const railGeo = boxGeo(span, 0.09, 0.11);
        const rail = pivotMesh(unitRoot, `${id}.rail`, railGeo, M.metal, 0, mountH, 0);
        // two uprights so the rail is standing on something rather than hovering
        const legGeo = boxGeo(0.08, mountH, 0.08);
        for (const sx of [-1, 1]) {
          const leg = new THREE.Mesh(legGeo, M.dark);
          leg.position.set(sx * span * 0.5, -mountH * 0.5, 0);
          leg.castShadow = true;
          leg.receiveShadow = true;
          rail.add(leg);
          parts.get(`${id}.rail`).meshes.push(leg);
        }
        const carriage = pivotMesh(unitRoot, `${id}.carriage`, boxGeo(0.16, 0.1, 0.16), M.alu, 0, mountH - 0.1, 0);
        chainRoot = carriage;
        chainDown = true;
      } else if (mount === 'wall') {
        const plate = pivotMesh(unitRoot, `${id}.base`, boxGeo(0.26, 0.26, 0.05), M.dark, 0, mountH, -0.03);
        chainRoot = plate;
      }
      const baseY = mount === 'pedestal' ? mountH : 0;
      if (mount !== 'wall') {
        pivotMesh(unitRoot, `${id}.base`, cylGeo(0.13, 0.15, 0.09), M.metal, 0, chainDown ? mountH - 0.16 : baseY, 0, 0, chainDown ? -0.045 : 0.045, 0);
      }

      // Serial chain: j1 yaws about y, the rest pitch about x, which is the shape of every
      // small 6-axis arm and makes `rotate` bindings on j2..jN read as joint angles. A gantry
      // builds the same chain with the link step inverted, so it grows toward the floor.
      const step = chainDown ? -seg : seg;
      let parent = mount === 'wall' ? chainRoot : unitRoot;
      let attachY = chainDown ? -0.16 : baseY + 0.09;
      if (mount === 'wall') attachY = 0.03;
      if (chainDown) parent = chainRoot;
      const linkGeo = capGeo(seg * 0.16, seg * 0.72);
      const jointGeo = sphGeo(seg * 0.2);
      for (let i = 1; i <= joints; i++) {
        const pivot = new THREE.Group();
        pivot.position.set(0, i === 1 ? attachY : step, 0);
        if (mount === 'wall' && i === 1) {
          pivot.position.set(0, 0, 0.04);
          pivot.rotation.x = Math.PI / 2; // the chain leaves a wall plate horizontally
        }
        parent.add(pivot);
        const knuckle = new THREE.Mesh(jointGeo, M.metal);
        knuckle.castShadow = true;
        pivot.add(knuckle);
        const link = new THREE.Mesh(linkGeo, i % 2 === 0 ? M.body : M.alu);
        link.position.y = step * 0.5;
        link.castShadow = true;
        pivot.add(link);
        addPart(`${id}.j${i}`, pivot, [knuckle, link]);
        parent = pivot;
        attachY = step;
      }

      const gripPivot = new THREE.Group();
      gripPivot.position.set(0, step, 0);
      parent.add(gripPivot);
      const palm = new THREE.Mesh(boxGeo(seg * 0.34, seg * 0.2, seg * 0.3), M.dark);
      palm.castShadow = true;
      gripPivot.add(palm);
      const fingerGeo = boxGeo(seg * 0.07, seg * 0.3, seg * 0.1);
      const fingers = [];
      for (const sgn of [-1, 1]) {
        const f = new THREE.Mesh(fingerGeo, M.alu);
        f.position.set(sgn * seg * 0.12, step * 0.24, 0);
        f.castShadow = true;
        gripPivot.add(f);
        fingers.push(f);
      }
      addPart(`${id}.gripper`, gripPivot, [palm, ...fingers]);
    }

    function buildMultirotor(unitRoot, id, p, M) {
      const rotors = pick(p.rotors, [4, 6, 8], 4);
      const span = size(p.span, 0.5);
      const hover = size(p.hover_h, 0.22);

      const bodyPivot = pivotMesh(unitRoot, `${id}.body`, boxGeo(span * 0.42, 0.09, span * 0.5), M.body, 0, hover, 0);
      const canopy = new THREE.Mesh(sphGeo(span * 0.16), M.dark);
      canopy.position.set(0, 0.05, span * 0.1);
      canopy.scale.set(1, 0.6, 1.2);
      canopy.castShadow = true;
      bodyPivot.add(canopy);
      parts.get(`${id}.body`).meshes.push(canopy);

      const armGeo = boxGeo(0.03, 0.022, span);
      const bossGeo = cylGeo(0.026, 0.03, 0.05);
      const discGeo = cylGeo(span * 0.3, span * 0.3, 0.006);
      const bladeGeo = boxGeo(span * 0.58, 0.005, 0.035);
      for (let i = 0; i < rotors; i++) {
        const a = (i / rotors) * Math.PI * 2 + Math.PI / rotors;
        const ax = Math.sin(a);
        const az = Math.cos(a);
        const armPivot = new THREE.Group();
        armPivot.position.set(0, hover, 0);
        armPivot.rotation.y = a;
        unitRoot.add(armPivot);
        const armMesh = new THREE.Mesh(armGeo, M.metal);
        armMesh.position.z = span * 0.5;
        armMesh.castShadow = true;
        armPivot.add(armMesh);
        addPart(`${id}.arm${i + 1}`, armPivot, [armMesh]);

        const boss = new THREE.Mesh(bossGeo, M.dark);
        boss.position.set(ax * span, hover + 0.03, az * span);
        boss.castShadow = true;
        unitRoot.add(boss);

        // rotor pivot spins about y, which is what a `spin` binding on axis y expects
        const rotorPivot = new THREE.Group();
        rotorPivot.position.set(ax * span, hover + 0.06, az * span);
        unitRoot.add(rotorPivot);
        const disc = new THREE.Mesh(discGeo, mat({ color: BRAND.blueHi, roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.16 }));
        rotorPivot.add(disc);
        const blades = [];
        for (const br of [0, Math.PI / 2]) {
          const b = new THREE.Mesh(bladeGeo, M.dark);
          b.rotation.y = br;
          b.castShadow = true;
          rotorPivot.add(b);
          blades.push(b);
        }
        addPart(`${id}.rotor${i + 1}`, rotorPivot, [disc, ...blades]);
      }

      const skidGeo = boxGeo(0.022, 0.022, span * 1.1);
      const strutGeo = boxGeo(0.018, hover * 0.7, 0.018);
      for (const [key, sgn] of [[`${id}.skid_l`, -1], [`${id}.skid_r`, 1]]) {
        const pivot = new THREE.Group();
        pivot.position.set(sgn * span * 0.28, 0.012, 0);
        unitRoot.add(pivot);
        const rail = new THREE.Mesh(skidGeo, M.alu);
        rail.castShadow = true;
        pivot.add(rail);
        const meshes = [rail];
        for (const sz of [-span * 0.28, span * 0.28]) {
          const st = new THREE.Mesh(strutGeo, M.alu);
          st.position.set(0, hover * 0.35, sz);
          st.castShadow = true;
          pivot.add(st);
          meshes.push(st);
        }
        addPart(key, pivot, meshes);
      }
    }

    function buildMarine(unitRoot, id, p, M) {
      const hullLen = size(p.hull_len, 0.9);
      const beam = size(p.beam, 0.22);
      const isSub = p.sub === true;
      const waterline = isSub ? beam * 0.1 : beam * 0.42;

      const hullPivot = pivotMesh(unitRoot, `${id}.hull`, capGeo(beam * 0.5, hullLen * 0.72), M.body, 0, waterline, 0);
      hullPivot.children[0].rotation.x = Math.PI / 2; // capsule runs bow to stern
      const deck = new THREE.Mesh(boxGeo(beam * 0.7, 0.035, hullLen * 0.5), M.dark);
      deck.position.y = beam * 0.42;
      deck.castShadow = true;
      hullPivot.add(deck);
      parts.get(`${id}.hull`).meshes.push(deck);

      const propGeo = cylGeo(beam * 0.02, beam * 0.02, 0.05);
      const bladeGeo = boxGeo(0.008, beam * 0.34, 0.05);
      for (const [key, sgn] of [[`${id}.prop_l`, -1], [`${id}.prop_r`, 1]]) {
        const pivot = new THREE.Group();
        pivot.position.set(sgn * beam * 0.34, waterline - beam * 0.14, -hullLen * 0.46);
        unitRoot.add(pivot);
        const shaft = new THREE.Mesh(propGeo, M.alu);
        shaft.rotation.x = Math.PI / 2;
        pivot.add(shaft);
        const meshes = [shaft];
        for (let b = 0; b < 3; b++) {
          const bl = new THREE.Mesh(bladeGeo, M.alu);
          bl.rotation.z = (b * Math.PI * 2) / 3;
          bl.position.set(Math.sin(bl.rotation.z) * -beam * 0.17, Math.cos(bl.rotation.z) * beam * 0.17, 0);
          bl.castShadow = true;
          pivot.add(bl);
          meshes.push(bl);
        }
        addPart(key, pivot, meshes);
      }

      pivotMesh(unitRoot, `${id}.fin`, boxGeo(0.02, beam * 0.72, hullLen * 0.16), M.metal, 0, waterline, -hullLen * 0.4, 0, beam * 0.32, 0);
      const mastH = size(p.mast_h, 0.4);
      const mastPivot = pivotMesh(unitRoot, `${id}.mast`, cylGeo(0.014, 0.018, mastH), M.alu, 0, waterline + beam * 0.42, hullLen * 0.06, 0, mastH * 0.5, 0);
      const lamp = new THREE.Mesh(sphGeo(0.026), M.led);
      lamp.position.y = mastH;
      mastPivot.add(lamp);
      parts.get(`${id}.mast`).meshes.push(lamp);

      if (isSub) {
        const ballast = pivotMesh(unitRoot, `${id}.ballast`, cylGeo(beam * 0.24, beam * 0.24, hullLen * 0.4), M.metal, 0, waterline - beam * 0.42, 0);
        ballast.children[0].rotation.x = Math.PI / 2; // ballast tank runs bow to stern too
        const planeGeo = boxGeo(beam * 0.8, 0.016, hullLen * 0.12);
        for (const [key, sgn] of [[`${id}.dive_plane_l`, -1], [`${id}.dive_plane_r`, 1]]) {
          pivotMesh(unitRoot, key, planeGeo, M.alu, sgn * beam * 0.62, waterline, hullLen * 0.24);
        }
      }
    }

    const BUILDERS = {
      wheeled: buildWheeled,
      legged: buildLegged,
      arm: buildArm,
      multirotor: buildMultirotor,
      marine: buildMarine,
    };

    // ---------------------------------------------------------------- extra parts and props
    /**
     * ONE size contract, honoured by every kind: `size` is [x, y, z] extents of the shape as
     * built, and for the axial kinds (cylinder, cone, capsule) that reads as
     * [diameter, diameter, length] with the axis along local +y before `rot` turns it.
     *
     * The old cylinder case took its length from s[1], so a 50 x 50 x 6 mm marker disc built as a
     * 50 mm chimney and a 75 mm dribbler roller built as a 12 mm dot. That was in the interpreter,
     * not in any def, so it deformed every extra part the generator will ever emit.
     */
    function primitive(kind, s, radius) {
      const r = size(radius, 0.08);
      switch (pick(kind, PRIMITIVE_KINDS, 'box')) {
        case 'cylinder':
          return cylGeo(size(s[0], r * 2) * 0.5, size(s[0], r * 2) * 0.5, size(s[2], r * 2));
        case 'cone':
          return cylGeo(0.0001, size(s[0], r * 2) * 0.5, size(s[2], r * 2));
        case 'sphere':
          return sphGeo(radius != null ? r : size(Math.max(nOr(s[0], 0), nOr(s[1], 0), nOr(s[2], 0)), 0.16) * 0.5);
        case 'torus':
          return torGeo(radius != null ? r : size(s[0], 0.1) * 0.5, size(s[1], 0.02) * 0.5);
        case 'capsule': {
          const cr = size(s[0], 0.05) * 0.5;
          // CapsuleGeometry's `length` is the cylinder run between the two caps, so the total
          // extent is length + 2r and the requested z has to have the caps taken out of it.
          return capGeo(cr, Math.max(size(s[2], 0.12) - cr * 2, 0.001));
        }
        default:
          return boxGeo(size(s[0], 0.1), size(s[1], 0.1), size(s[2], 0.1));
      }
    }

    /**
     * Named finishes rather than raw material numbers. Five names cover every part a robot has,
     * and none of them can produce an invisible or blown-out surface the way loose roughness /
     * metalness / opacity fields could.
     */
    function finishMat(color, finish) {
      switch (pick(finish, ['matte', 'metal', 'rubber', 'glass', 'emissive'], 'matte')) {
        case 'metal':
          return mat({ color, roughness: 0.28, metalness: 0.92 });
        case 'rubber':
          return mat({ color, roughness: 0.95, metalness: 0.02 });
        case 'glass':
          return mat({ color, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.25, depthWrite: false });
        case 'emissive':
          return mat({ color, roughness: 0.4, metalness: 0.0, emissive: color, emissiveIntensity: 1.1 });
        default:
          return mat({ color, roughness: 0.5, metalness: 0.4 });
      }
    }

    function buildExtraParts(unitRoot, id, unit, M) {
      const extras = (Array.isArray(unit.extra_parts) ? unit.extra_parts : []).slice(0, SCENE_CAPS.maxExtraParts);
      let budget = SCENE_CAPS.maxPartsPerUnit - archetypeParts(unit.archetype, unit.params).length;
      for (const ex of extras) {
        if (budget <= 0) break;
        if (!ex || typeof ex.id !== 'string' || !ex.id) continue;
        budget--;
        const s = Array.isArray(ex.size) ? ex.size : [];
        const g = primitive(ex.kind, s, ex.radius);
        const material = finishMat(colorOf(ex.color, BRAND.alu), ex.finish);
        const parentEntry = typeof ex.parent === 'string' ? parts.get(`${id}.${ex.parent}`) : null;
        const host = parentEntry ? parentEntry.node : unitRoot;
        const pos = Array.isArray(ex.pos) ? ex.pos : [];
        const rot = Array.isArray(ex.rot) ? ex.rot : [];
        const pivot = pivotMesh(host, `${id}.${ex.id}`, g, material, nOr(pos[0], 0), nOr(pos[1], 0), nOr(pos[2], 0));
        pivot.rotation.set(nOr(rot[0], 0), nOr(rot[1], 0), nOr(rot[2], 0));
        if (ex.finish === 'glass') pivot.children[0].castShadow = false;
        // An extra part mounted straight on the unit root with no y given is standing on the
        // ground, not floating at its own centre: lift it by its own half-height.
        if (!parentEntry && nOr(pos[1], 0) === 0) restOnFloor(pivot.children[0], g);
        // Deck parts and the accent trim are authored independently, so they can be told to
        // occupy the same millimetres. Nudge the part up out of the trim rather than letting two
        // solids interpenetrate, which is the most reliable tell that nobody checked.
        if (build.trim && host === build.trim.host) {
          g.computeBoundingBox();
          const bb = g.boundingBox;
          const py = pivot.position.y + pivot.children[0].position.y;
          const lo = py + bb.min.y;
          const hi = py + bb.max.y;
          const withinXZ = Math.abs(pivot.position.x) - bb.max.x < build.trim.x
            && Math.abs(pivot.position.z) - bb.max.z < build.trim.z;
          if (withinXZ && hi > build.trim.y0 && lo < build.trim.y1) pivot.position.y += build.trim.y1 - lo;
        }
      }
    }

    // ---------------------------------------------------------------- ground contact
    // Nothing in a scene like this reads as touching the floor without a shadow directly under
    // it. The real shadow map covers the whole play area at a few millimetres a texel and cannot
    // resolve a 27 mm wheel, so every unit and prop also carries one 2-triangle gradient quad
    // parented to its own node - it tracks the object for free, costs one shared material and
    // one shared texture, and its spread and opacity answer to how high off the ground it is.
    let shadowTex = null;
    let shadowMat = null;
    let shadowGeo = null;
    const shadows = [];

    function ensureShadowAssets() {
      if (shadowTex) return;
      const N = 64;
      const buf = new Uint8Array(N * N * 4);
      for (let iv = 0; iv < N; iv++) {
        for (let iu = 0; iu < N; iu++) {
          const dx = (iu + 0.5) / N - 0.5;
          const dz = (iv + 0.5) / N - 0.5;
          const d = Math.sqrt(dx * dx + dz * dz) * 2;
          // A dark plateau under the object with a soft penumbra around it. A pure quadratic
          // falloff spreads all its density over the skirt and leaves the contact point barely
          // darker than clean floor, which is the reading the audit measured at a 0% delta.
          const k = clamp((1 - d) / 0.62, 0, 1);
          const a = Math.round(255 * Math.pow(k, 1.4));
          const i = (iv * N + iu) * 4;
          // three.js reads alphaMap from the GREEN channel, not from alpha, so the falloff has to
          // live in rgb. A white square here is exactly how a soft shadow becomes a hard rectangle.
          buf[i] = a;
          buf[i + 1] = a;
          buf[i + 2] = a;
          buf[i + 3] = a;
        }
      }
      shadowTex = new THREE.DataTexture(buf, N, N, THREE.RGBAFormat);
      shadowTex.minFilter = THREE.LinearFilter;
      shadowTex.magFilter = THREE.LinearFilter;
      shadowTex.needsUpdate = true;
      textures.push(shadowTex);
      shadowMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.58,
        alphaMap: shadowTex,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -8,
      });
      mats.push(shadowMat);
      shadowGeo = geo(new THREE.PlaneGeometry(1, 1));
      shadowGeo.rotateX(-Math.PI / 2);
    }

    /**
     * Attach a contact shadow to `node`, sized to a footprint of `halfX` x `halfZ`. The material
     * is cloned per object because opacity has to answer to THAT object's height off the ground -
     * a lobbed ball's shadow spreads and fades, a parked one's does not.
     */
    function addContactShadow(node, halfX, halfZ) {
      ensureShadowAssets();
      const om = shadowMat.clone();
      mats.push(om);
      const m = new THREE.Mesh(shadowGeo, om);
      m.userData.contactShadow = true;
      // 1.7x the footprint: wide enough for a penumbra, tight enough that the darkest part of the
      // gradient lands under the object rather than beside it
      const sx = Math.max(halfX, 0.01) * 3.4;
      const sz = Math.max(halfZ, 0.01) * 3.4;
      m.scale.set(sx, 1, sz);
      m.position.y = 0.0015;
      m.renderOrder = 2;
      node.add(m);
      shadows.push({ mesh: m, node, sx, sz });
      return m;
    }

    /** Sit a mesh on y = 0 by its own bounding box, whatever primitive it happens to be. */
    function restOnFloor(mesh, g) {
      g.computeBoundingBox();
      mesh.position.y -= g.boundingBox.min.y;
    }

    const scratchBox = new THREE.Box3();

    // ---------------------------------------------------------------- units
    const movers = [];
    /** Ground-plane hulls a ball is not allowed to be inside. Top-level units only. */
    const unitBoxes = [];
    /**
     * Every top-level unit as an XZ disc, for the unit-vs-unit push-out. A PARENTED unit is not
     * here on purpose: its `position` is an offset inside its host, not a point in root space, so
     * comparing it against root-space centres is meaningless - and the host it rides is already in
     * the list carrying the footprint of both. `movable` is false for a unit posed once at build.
     */
    const unitDiscs = [];
    /** id -> unit root, so a parented unit and a `face:` yaw can resolve their target. */
    const unitNodes = new Map();
    // Parents build first, so a child can attach to a part that already exists. Depth is capped at
    // one: a unit whose parent is itself parented is treated as a root, which makes a cycle
    // structurally impossible without walking a graph.
    const parentRefOf = (u) => (u && typeof u.parent === 'string' && u.parent.indexOf('.') > 0 ? u.parent : null);
    const parentIds = new Set();
    for (const u of units) {
      const ref = parentRefOf(u);
      if (ref) parentIds.add(ref.slice(0, ref.indexOf('.')));
    }
    const ordered = [
      ...units.filter((u) => !parentRefOf(u)),
      ...units.filter((u) => parentRefOf(u) && !parentIds.has(u && u.id)),
    ];

    for (const unit of ordered) {
      if (!unit || typeof unit.id !== 'string' || !unit.id) continue;
      const id = unit.id;
      const unitRoot = new THREE.Group();
      unitRoot.name = id;
      const ref = parentRefOf(unit);
      const hostEntry = ref ? parts.get(ref) : null;
      (hostEntry ? hostEntry.node : root).add(unitRoot);
      unitNodes.set(id, unitRoot);
      build = { wheels: [], wheelR: 0, trim: null };
      const M = unitMaterials(colorOf(unit.tint, BRAND.blueHi));
      const archetype = pick(unit.archetype, Object.keys(BUILDERS), 'wheeled');
      const uParams = unit.params && typeof unit.params === 'object' ? unit.params : {};
      const builder = BUILDERS[archetype];
      builder(unitRoot, id, uParams, M);
      buildExtraParts(unitRoot, id, unit, M);

      scratchBox.setFromObject(unitRoot);
      const halfX = Number.isFinite(scratchBox.min.x) ? (scratchBox.max.x - scratchBox.min.x) * 0.5 : 0.2;
      const halfZ = Number.isFinite(scratchBox.min.z) ? (scratchBox.max.z - scratchBox.min.z) * 0.5 : 0.2;
      const top = Number.isFinite(scratchBox.max.y) ? scratchBox.max.y : 0.3;
      const bottom = Number.isFinite(scratchBox.min.y) ? scratchBox.min.y : 0;
      // One radius, used by BOTH post-passes. A cylindrical hull is the case that needs it: its
      // AABB corners overhang the hull by 41 percent, so a ball pushed out diagonally on the box
      // test came to rest visibly off the flank, floating in the gap between corner and hull.
      const collR = collisionRadiusOf(archetype, uParams, halfX, halfZ);
      const collCyl = archetype === 'wheeled' && pick(uParams.body_shape, ['box', 'cylinder'], 'box') === 'cylinder';
      // A unit mounted on another unit does not get its own ground shadow: it is not on the
      // ground, and its root's y is a local offset inside its parent, not a height above the floor.
      if (!hostEntry) addContactShadow(unitRoot, halfX, halfZ);

      const motion = compileMotion(unit.motion);
      if (hostEntry) {
        // A mounted unit rides its parent. Its own motion is a local offset, never a second track:
        // two copies of the same waypoint list drift the moment either one is edited.
        unitRoot.position.set(motion.x || 0, motion.y || 0, motion.z || 0);
        unitRoot.rotation.y = motion.yaw || 0;
      } else if (motion.kind === 'static') {
        unitRoot.position.set(motion.x, motion.y, motion.z);
        unitRoot.rotation.y = motion.yaw;
      } else {
        movers.push({
          node: unitRoot,
          motion,
          wheels: build.wheels,
          wheelR: build.wheelR,
          chassis: true,
          // every vertical amplitude and lean gain, sized off THIS unit rather than off a constant
          dyn: verticalDynamics(halfX, halfZ, top - bottom),
          ball: false,
          ballR: 0,
          mesh: null,
          baseY: 0,
          halfX,
          halfZ,
          top,
          axisX: 0,
          axisZ: 1,
          chX: 0,
          chZ: 0,
          chYaw: 0,
        });
      }
      if (!hostEntry) {
        // `motion` rides along so a contact pass can ask where this unit's own TRACK put it at any
        // time, which is what conditions the separation axis below.
        unitBoxes.push({ node: unitRoot, halfX, halfZ, top, bottom, r: collR, cyl: collCyl, motion });
        unitDiscs.push({ node: unitRoot, r: collR, movable: motion.kind !== 'static', motion });
      }
    }

    // ---------------------------------------------------------------- props
    for (const prop of props) {
      if (!prop || typeof prop.id !== 'string' || !prop.id) continue;
      const s = Array.isArray(prop.size) ? prop.size : [];
      const kind = pick(prop.kind, PRIMITIVE_KINDS, 'box');
      const g = primitive(prop.kind, s, prop.radius);
      const material = prop.finish ? finishMat(colorOf(prop.color, 0x8a8f96), prop.finish)
        : mat({ color: colorOf(prop.color, 0x8a8f96), roughness: 0.62, metalness: 0.18 });
      const pivot = new THREE.Group();
      root.add(pivot);
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = prop.finish !== 'glass';
      mesh.receiveShadow = true;
      const motion = compileMotion(prop.motion);
      // Every prop rests ON the floor, not centred in it. Only a prop whose def gives it an
      // explicit non-zero y is taken at its word - that is the one case where the author meant
      // "in the air". A goal sunk to half its height in the turf was in every single frame.
      if (!(motion.kind === 'static' && motion.y !== 0)) restOnFloor(mesh, g);
      pivot.add(mesh);
      addPart(prop.id, pivot, [mesh]);
      g.computeBoundingBox();
      const pHalfX = (g.boundingBox.max.x - g.boundingBox.min.x) * 0.5;
      const pHalfZ = (g.boundingBox.max.z - g.boundingBox.min.z) * 0.5;
      addContactShadow(pivot, pHalfX, pHalfZ);
      if (motion.kind === 'static') {
        pivot.position.set(motion.x, motion.y, motion.z);
        pivot.rotation.y = motion.yaw;
      } else {
        movers.push({
          node: pivot,
          motion,
          wheels: null,
          wheelR: 0,
          chassis: false,
          dyn: null,
          // A ball rolls: its spin is arc length over its own radius, about the axis square to
          // travel. That is the whole of ball physics here and it is exact under a scrub.
          ball: kind === 'sphere',
          ballR: kind === 'sphere' ? Math.max(mesh.position.y, 0.005) : 0,
          // The roll belongs to the BALL, not to the ball's ground anchor: the pivot sits on the
          // floor and the mesh sits one radius above it, so spinning the pivot swung the ball
          // through a circle of its own radius about the contact point and buried it in the floor
          // for half of every revolution. The sphere's geometry is centred on its mesh, so giving
          // the mesh the quaternion spins it about its own centre and the centre stays at y = r.
          mesh,
          baseY: 0,
          halfX: pHalfX,
          halfZ: pHalfZ,
          top: g.boundingBox.max.y,
          axisX: 0,
          axisZ: 1,
          chX: 0,
          chZ: 0,
          chYaw: 0,
        });
      }
    }

    // A `face:<id>` yaw names a unit or a prop, so it can only be resolved once everything is
    // built. An unresolvable name simply falls back to facing the direction of travel.
    for (const mv of movers) {
      const m = mv.motion;
      if (m.yawKind !== 'face') continue;
      const entry = parts.get(m.yawRef);
      m.yawNode = unitNodes.get(m.yawRef) || (entry ? entry.node : null);
      if (!m.yawNode) m.yawKind = 'travel';
    }
    const faceMovers = movers.filter((mv) => mv.motion.yawKind === 'face' && mv.motion.yawNode);

    // ---------------------------------------------------------------- bindings
    // Compiled once into flat records. `base` freezes the rest pose so a binding that stops
    // being driven (channel absent, value zero) returns the part to where it was built.
    const compiled = [];
    for (const b of bindings) {
      if (!b || typeof b !== 'object') continue;
      const entry = parts.get(b.part);
      if (!entry) continue; // the validator resolved this already; a stale ref is silently inert
      const field = splitField(b.channel);
      if (!field) continue;
      const kind = pick(b.kind, ['spin', 'rotate', 'tilt', 'glow', 'wobble', 'offset'], 'rotate');
      const axis = axisOf(b.axis, kind === 'spin' ? 'x' : 'z');
      const gain = nOr(b.gain, 1);
      const rec = {
        kind,
        axis,
        gain,
        field,
        node: entry.node,
        meshes: entry.meshes,
        baseX: entry.node.position.x,
        baseY: entry.node.position.y,
        baseZ: entry.node.position.z,
        baseRot: entry.node.rotation[axis],
        min: nOr(b.min, 0),
        max: nOr(b.max, 1),
        trackSrc: null,
        trackT: null,
        trackV: null,
      };
      if (kind === 'glow') {
        // Glow needs its own material instance, otherwise lighting one part lights every part
        // that happened to share a material with it.
        rec.glowMats = entry.meshes.map((m) => {
          const g = m.material.clone();
          g.emissive = new THREE.Color(BRAND.blueHi);
          g.emissiveIntensity = 0;
          mats.push(g);
          m.material = g;
          return g;
        });
        if (rec.max <= rec.min) rec.max = rec.min + 1;
      }
      compiled.push(rec);
    }
    // A wheel on a unit that drives a waypoint path rolls off the ground it is on, so its spin
    // binding is retired: /drive.vel is a synthetic telemetry stream with its own event profile
    // and the waypoint list is a separately authored path, and rendering one as the other is what
    // made the wheels turn backwards at three times the right rate. A `spin` on a static or
    // channel-driven unit still runs off its channel, which is the case where the channel IS the
    // ground truth.
    const arcWheels = new Set();
    for (const mv of movers) {
      if (!mv.chassis || !mv.wheels) continue;
      for (const w of mv.wheels) arcWheels.add(w);
    }
    const spins = compiled.filter((r) => r.kind === 'spin' && !arcWheels.has(r.node));

    /**
     * Spin is an integral, not a per-frame increment: a scrub backwards has to unwind the wheel
     * to exactly where it was, and an increment cannot do that. The cumulative integral of the
     * channel is built the first time real data arrives and reused until the arrays change.
     */
    function ensureSpinTracks(data) {
      for (const r of spins) {
        const ch = data[r.field.path];
        if (!ch || !ch.t) continue;
        const arr = ch[r.field.key];
        if (!arr || r.trackSrc === ch.t) continue;
        const n = ch.t.length;
        const acc = new Float64Array(n);
        let s = 0;
        for (let i = 1; i < n; i++) {
          s += (arr[i] + arr[i - 1]) * 0.5 * (ch.t[i] - ch.t[i - 1]);
          acc[i] = s;
        }
        r.trackSrc = ch.t;
        r.trackT = ch.t;
        r.trackV = acc;
      }
    }

    // ---------------------------------------------------------------- highlight
    // Same idiom as sbr/scene.js: a cloned material with an alert-red emissive, swapped in on
    // the highlighted part only, pulsing from update(). Clones are cached per base material so
    // a 40-part unit does not mint 40 near-identical materials.
    let highlight = null;
    let hotEntry = null;
    const hotFor = new Map();

    function hotMaterial(base) {
      let hot = hotFor.get(base);
      if (!hot) {
        hot = base.clone();
        hot.emissive = new THREE.Color(BRAND.alert);
        hot.emissiveIntensity = 0;
        mats.push(hot);
        hotFor.set(base, hot);
      }
      return hot;
    }

    function setHighlight(ref) {
      const next = ref || null;
      if (next === highlight) return;
      if (hotEntry) {
        for (const m of hotEntry.meshes) {
          if (m.userData.genBaseMat) {
            m.material = m.userData.genBaseMat;
            m.userData.genBaseMat = null;
          }
        }
      }
      highlight = next;
      hotEntry = next ? parts.get(next) || null : null;
      if (!hotEntry) return;
      for (const m of hotEntry.meshes) {
        m.userData.genBaseMat = m.material;
        m.material = hotMaterial(m.material);
      }
    }

    // ---------------------------------------------------------------- motion evaluation
    // Scratch objects, allocated once. update() must never allocate: it runs every frame.
    const sHere = { x: 0, z: 0 };
    const sAhead = { x: 0, z: 0 };
    const sBack = { x: 0, z: 0 };
    const rollAxis = new THREE.Vector3(1, 0, 0);
    const YAW_EPS = 0.08;
    /** Finite-difference window for chassis dynamics. Wide enough to survive spline noise. */
    const DYN_DT = 0.16;

    function applyMotion(mv, tSec, data) {
      const m = mv.motion;
      if (m.kind === 'waypoints') {
        waypointAt(m, tSec, sHere);
        mv.node.position.x = sHere.x;
        mv.node.position.z = sHere.z;
        mv.node.position.y = mv.baseY;
        waypointAt(m, tSec + YAW_EPS, sAhead);
        const dx = sAhead.x - sHere.x;
        const dz = sAhead.z - sHere.z;
        const moving = dx * dx + dz * dz > 1e-8;

        if (m.yawKind === 'fixed') {
          mv.node.rotation.y = m.yawVal;
        } else if (m.yawKind === 'channel') {
          mv.node.rotation.y = readField(data, m.yawField, tSec, mv.node.rotation.y);
        } else if (m.yawKind === 'face' && m.yawNode) {
          // handled in applyFaceYaw, once the thing being faced has also been placed
        } else if (moving) {
          // below a fraction of a millimetre of travel the direction is noise, so hold the yaw
          mv.node.rotation.y = Math.atan2(dx, dz);
        }

        const arc = arcAt(m, tSec);

        if (mv.ball) {
          // Roll is arc length over radius about the axis square to travel, written as an absolute
          // orientation rather than accumulated, so it reverses with the ball and rewinds exactly.
          if (moving) {
            const inv = 1 / Math.sqrt(dx * dx + dz * dz);
            mv.axisX = -dz * inv;
            mv.axisZ = dx * inv;
          }
          rollAxis.set(mv.axisX, 0, mv.axisZ);
          // The axis is stated in root space, so the pivot must carry no rotation of its own or the
          // roll would be applied inside a yawed frame. A sphere has no heading to lose.
          mv.node.rotation.set(0, 0, 0);
          mv.mesh.quaternion.setFromAxisAngle(rollAxis, arc / mv.ballR);
          return;
        }

        if (mv.chassis) {
          if (mv.wheels && mv.wheelR > 0) {
            const roll = arc / mv.wheelR;
            for (let i = 0; i < mv.wheels.length; i++) mv.wheels[i].rotation.x = roll;
          }
          // Chassis attitude comes off the path, not off a channel: lateral acceleration leans the
          // body into a turn, longitudinal acceleration squats it under braking, and a small bob
          // keyed to distance travelled (not to wall-clock time, so a scrub reproduces it) puts
          // the suspension back under a vehicle that was sliding as a rigid cutout.
          waypointAt(m, tSec - DYN_DT, sBack);
          waypointAt(m, tSec + DYN_DT, sAhead);
          const vx = (sAhead.x - sBack.x) / (2 * DYN_DT);
          const vz = (sAhead.z - sBack.z) / (2 * DYN_DT);
          const ax = (sAhead.x - 2 * sHere.x + sBack.x) / (DYN_DT * DYN_DT);
          const az = (sAhead.z - 2 * sHere.z + sBack.z) / (DYN_DT * DYN_DT);
          const sp = Math.sqrt(vx * vx + vz * vz);
          const dyn = mv.dyn;
          if (sp > 1e-6) {
            const fx = vx / sp;
            const fz = vz / sp;
            const along = ax * fx + az * fz;
            const lat = ax * -fz + az * fx;
            // Lean as a fraction of this unit's OWN tipping acceleration, so the angle a robot
            // reaches depends on how hard it is cornering FOR ITS SIZE. An absolute gain gave a
            // 180 mm robot at soccer accelerations the lean of a superbike.
            const roll = dyn.maxRoll * clamp(lat / dyn.tipLat, -1, 1);
            const pitch = -dyn.maxPitch * clamp(along / dyn.tipLong, -1, 1);
            mv.node.rotation.z = roll;
            mv.node.rotation.x = pitch;
            // A vehicle leans about its contact patch, not about its centre, so the lean has to be
            // paid for in height or the outside wheel goes through the floor. The bob rides on top
            // of that and is keyed to distance travelled, never to wall-clock time, so a scrub
            // reproduces it exactly. Every term is a fraction of body height: lean lift and bob
            // together cannot exceed VERT_FRAC of the unit.
            mv.node.position.y = mv.baseY
              + mv.halfX * Math.abs(Math.sin(roll))
              + mv.halfZ * Math.abs(Math.sin(pitch))
              + dyn.bobAmp * (0.5 + 0.5 * Math.sin(arc * dyn.bobK));
          } else {
            // Standing still is a pose, not "whatever the last moving frame left behind": holding a
            // stale lean while the ride height has already been reset to baseY drops a leaning
            // chassis through the floor, and it makes the frame depend on which frames ran before.
            mv.node.rotation.z = 0;
            mv.node.rotation.x = 0;
            mv.node.position.y = mv.baseY + dyn.bobAmp * (0.5 + 0.5 * Math.sin(arc * dyn.bobK));
          }
        }
        return;
      }
      // channels
      //
      // The fallback is the mover's own last TRACK value, never the node's current transform. The
      // node carries the push-out this frame's separation passes applied to it, and feeding that
      // back in as next frame's starting point is exactly the accumulation that makes a scrub
      // land somewhere the first play-through never went. An unresolvable channel now holds the
      // pose it was built at, forever, which is a pure function of t.
      mv.chX = readField(data, m.x, tSec, mv.chX);
      mv.chZ = readField(data, m.z, tSec, mv.chZ);
      mv.chYaw = readField(data, m.yaw, tSec, mv.chYaw);
      mv.node.position.x = mv.chX;
      mv.node.position.z = mv.chZ;
      mv.node.rotation.y = mv.chYaw;
    }

    // ---------------------------------------------------------------- contact resolution
    /** Units come to rest this much clear of true contact, so a touch reads as a touch. */
    const CONTACT_MARGIN = 1.04;
    /**
     * Sweep cap for the pairwise pass. One sweep is exact for a single pair but leaves a residue
     * at three or more, because resolving A-B can push A straight back into C. Measured on the
     * three-way converging-waypoints case this pass exists to fix: one sweep leaves 13 percent of
     * contact overlapping, two leaves 9 percent, three clears it, and it is flat by six. The loop
     * therefore sweeps until a sweep finds nothing left to resolve, capped here.
     *
     * The early exit costs nothing and changes no result - it runs only when the previous sweep
     * separated every pair - so the pass stays a pure function of the frame's poses, which is what
     * a scrub depends on. The cap bounds the worst case at 6 units x 15 pairs x 6 sweeps of scalar
     * arithmetic, and the common case (nothing touching) exits after one.
     */
    const CONTACT_MAX_SWEEPS = 6;
    /**
     * Sweep cap for the ball pass, which needs more of them than the unit pass because averaging a
     * sweep's answers converges on a squeeze rather than solving it outright: a ball pinched
     * between two robots that are themselves in contact has no position clear of both, and the
     * sweeps walk it to the least bad one. Measured on the live def's t=42 pinch, six sweeps left
     * it mid-escape and jumping 32 mm in a frame, and it is flat by twenty. One ball against six
     * hulls is a rounding error next to a single draw call.
     */
    const PROP_MAX_SWEEPS = 24;
    /**
     * Separation direction for the degenerate case of two units at EXACTLY the same point, where
     * the centre line does not exist. Golden-angle indexed by pair, so a pile fans out instead of
     * stacking along one axis, and precomputed so the pass allocates nothing per frame.
     */
    // Unit-vs-unit pairs index the front of both arrays, then one slot per ball-vs-unit pair; every
    // mover that is a ball carries the offset of its own block.
    const pairCount = (unitDiscs.length * Math.max(unitDiscs.length - 1, 0)) / 2;
    let axisSlots = pairCount;
    for (const mv of movers) {
      if (!mv.ball) continue;
      mv.axisBase = axisSlots;
      axisSlots += unitBoxes.length;
    }
    const pairAxX = new Float64Array(axisSlots);
    const pairAxZ = new Float64Array(axisSlots);
    for (let k = 0; k < axisSlots; k++) {
      const th = k * 2.399963229728653;
      pairAxX[k] = Math.sin(th);
      pairAxZ[k] = Math.cos(th);
    }
    /** This frame's separation axis per pair, recomputed from the raw tracks every frame. */
    const sepAxX = new Float64Array(axisSlots);
    const sepAxZ = new Float64Array(axisSlots);

    /**
     * How far the separation axis is held off the pair's centre line, as a fraction of the distance
     * the pair is held at.
     *
     * WHY NOT JUST THE CENTRE LINE. A generated soccer def routinely authors two robots onto the
     * same point - both are chasing the same ball and the model writes each track without looking
     * at the other. Measured on the live RCJ def, the striker and an opponent close to 2.3 mm
     * apart at t=12.75 and pass through each other almost exactly head on. Pushing them apart
     * along the instantaneous centre line is exact and useless, because the centre line of two
     * coincident points SPINS: it swept 180 degrees in a fifth of a second, and since the pass
     * holds the pair a full contact distance apart, both robots were flung around each other at
     * 3.09 m/s while their own tracks crawled at 0.11 m/s. That is the "bouncing around", and the
     * ball got the same treatment from the robot dribbling it - 60 mm in one frame, which whipped
     * every `face:ball` chassis after it at 2594 deg/s.
     *
     * The axis therefore resolves along the centre line OFFSET by a fixed vector: the pair's own
     * golden-angle direction, a fraction of their contact distance long. Three things follow, and
     * they are the whole design:
     *
     *   - the offset never vanishes, so the axis never spins: as the pair sweeps through
     *     coincidence the axis rotates by at most 180 degrees spread over the WHOLE encounter,
     *     which is the slowest any non-penetrating resolution can possibly turn it;
     *   - at first and last contact the correction is zero whatever the axis, because a pair that
     *     is already `want` apart needs no push along any direction within 90 degrees of its
     *     centre line - so the pass fades in and out instead of teleporting;
     *   - the offset direction is a constant of the pair, so it cannot flip mid-encounter, which
     *     is what every direction blended from the instantaneous geometry does at exactly the
     *     moment the geometry is degenerate.
     *
     * Two units that meet head on now sidestep each other rather than swapping places in one
     * frame. Everything is read from the raw tracks at absolute times, never from a previous
     * frame, so a scrub still reproduces it bit for bit.
     */
    /** Seconds either side of the frame the pair's crossing chord is measured over. */
    const SEP_SPAN = 0.5;
    /**
     * How close a pair has to get, as a fraction of the distance they are held at, before the
     * chord treatment applies at all. Outside it the centre line is perfectly stable - measured on
     * the live def it holds within a degree for seconds at a time - and the pass leaves it alone;
     * inside it the centre line is what spins. Small on purpose: the further out this reaches, the
     * more often a pair is resolved along something other than the obvious direction.
     */
    const SEP_NEAR = 0.25;
    /**
     * How much miss counts as a miss, as a sine: below it the pair's tracks are meeting dead on and
     * which side they pass on is not information the geometry contains, so a fixed per-pair choice
     * has to stand in for it.
     */
    const SEP_SIDE_EPS = 0.1;
    const sepA = { x: 0, z: 0 };
    const sepB = { x: 0, z: 0 };
    /** The time the current frame is being evaluated at, read by the contact passes. */
    let tSec_ = 0;

    /**
     * Where a contact body's own TRACK puts it at `tSec`, before any separation pass touched it.
     * A channel-driven or static body has no track to re-evaluate, so it answers with the pose it
     * is already holding - which degrades this to the plain centre-line behaviour.
     */
    function rawAt(rec, tSec, out) {
      const m = rec.motion;
      if (m && m.kind === 'waypoints') {
        waypointAt(m, tSec, out);
        return;
      }
      out.x = rec.node.position.x;
      out.z = rec.node.position.z;
    }

    /**
     * The separation axis for one pair this frame, written into sepAx[k].
     *
     * Off the RAW tracks, never off the poses the sweeps are editing: the pushed positions already
     * carry the correction, and reading the axis back out of them would define it in terms of
     * itself.
     */
    function conditionAxis(k, a, b, want) {
      // The chord: where the pair is headed RELATIVE to each other across this window. An encounter
      // is a crossing of it, and resolving square to it is what makes the pair slide around each
      // other over the whole encounter instead of swapping places in one frame.
      rawAt(a, tSec_ - SEP_SPAN, sepA);
      rawAt(b, tSec_ - SEP_SPAN, sepB);
      const backX = sepB.x - sepA.x;
      const backZ = sepB.z - sepA.z;
      rawAt(a, tSec_ + SEP_SPAN, sepA);
      rawAt(b, tSec_ + SEP_SPAN, sepB);
      const fwdX = sepB.x - sepA.x;
      const fwdZ = sepB.z - sepA.z;
      const chordX = fwdX - backX;
      const chordZ = fwdZ - backZ;
      const chordD = Math.sqrt(chordX * chordX + chordZ * chordZ);
      rawAt(a, tSec_, sepA);
      rawAt(b, tSec_, sepB);
      const rx = sepB.x - sepA.x;
      const rz = sepB.z - sepA.z;
      const rd = Math.sqrt(rx * rx + rz * rz);
      // The chord treatment fades in as the pair closes and out again for a pair that is barely
      // moving relative to each other - neither a distant pair nor a stationary one has a spinning
      // centre line to fix, and outside this the pass resolves along the centre line exactly as it
      // always did.
      const near = SEP_NEAR * want;
      const w = (1 - Math.min(rd / near, 1)) * Math.min(chordD / near, 1);
      let ax = 0;
      let az = 0;
      if (w > 0) {
        // Square to the chord, pointed at the side the pair is passing on.
        //
        // WHICH side is read off the area the relative position sweeps across the window's ENDS,
        // where the pair is well separated - never off the miss at this instant. The instantaneous
        // miss goes through zero exactly when the pair is concentric, which is the one moment the
        // answer has to hold still: signing off it flipped the axis mid-crossing and threw both
        // robots a contact distance apart in a single frame. The swept area is the miss times the
        // closing speed, so it is a CONSTANT of a straight crossing and cannot flip inside one.
        //
        // A pair whose tracks meet dead on sweeps no area at all, because there is genuinely no
        // side to prefer, so below a tenth of a radian of miss the pair's own golden angle picks
        // one and never changes its mind.
        let px = -chordZ / chordD;
        let pz = chordX / chordD;
        const swept = backX * fwdZ - backZ * fwdX;
        const scale = Math.sqrt((backX * backX + backZ * backZ) * (fwdX * fwdX + fwdZ * fwdZ));
        const sign = Math.abs(swept) > SEP_SIDE_EPS * scale ? -swept : px * pairAxX[k] + pz * pairAxZ[k];
        if (sign < 0) {
          px = -px;
          pz = -pz;
        }
        ax = w * px;
        az = w * pz;
      }
      if (rd > 1e-12) {
        ax += ((1 - w) * rx) / rd;
        az += ((1 - w) * rz) / rd;
      }
      const al = Math.sqrt(ax * ax + az * az);
      if (al > 1e-12) {
        sepAxX[k] = ax / al;
        sepAxZ[k] = az / al;
      } else {
        // concentric and not moving apart: fan out along the pair's own golden-angle direction
        sepAxX[k] = pairAxX[k];
        sepAxZ[k] = pairAxZ[k];
      }
    }

    /**
     * Displacement along `axis` that puts two centres exactly `want` apart, given their current
     * offset. Solving it rather than projecting onto the centre line is what lets the pass hold
     * the pair on a stable axis and still land on the separation distance exactly.
     */
    function pushAlong(relX, relZ, axX, axZ, want) {
      const c = relX * axX + relZ * axZ;
      const d2 = relX * relX + relZ * relZ;
      return -c + Math.sqrt(Math.max(c * c + want * want - d2, 0));
    }

    /**
     * After every mover is placed, push overlapping units off each other in the ground plane.
     *
     * Three robots converging on one waypoint used to end up sharing a volume, which is the single
     * most obviously fake thing a fleet scene can do. This is the same class of post-pass as the
     * ball separation below - not a solver, no momentum, no restitution - and it earns the same
     * guarantee: it reads ONLY the poses the tracks produced this frame and writes them back the
     * same frame, so it is a pure function of `tSec` and scrubbing reproduces it exactly. Nothing
     * is carried between frames.
     *
     * Each unit is a disc, split equally when both are free to move and paid entirely by the mover
     * when the other is static (an anchored unit is scenery, and shoving the scenery is worse than
     * the overlap). Contact shadows need no special handling: they are children of the node.
     */
    function separateUnits() {
      // The axis is a property of the pair's PATHS, not of the poses the sweeps are editing, so it
      // is conditioned once per frame and every sweep then relaxes along it.
      let pk = 0;
      for (let i = 0; i < unitDiscs.length; i++) {
        const a = unitDiscs[i];
        for (let j = i + 1; j < unitDiscs.length; j++) {
          const b = unitDiscs[j];
          const k = pk++;
          if (!a.movable && !b.movable) continue;
          conditionAxis(k, a, b, (a.r + b.r) * CONTACT_MARGIN);
        }
      }
      for (let sweep = 0; sweep < CONTACT_MAX_SWEEPS; sweep++) {
        let pi = 0;
        let resolved = false;
        for (let i = 0; i < unitDiscs.length; i++) {
          const a = unitDiscs[i];
          for (let j = i + 1; j < unitDiscs.length; j++) {
            const b = unitDiscs[j];
            const k = pi++;
            if (!a.movable && !b.movable) continue;
            const want = (a.r + b.r) * CONTACT_MARGIN;
            const dx = b.node.position.x - a.node.position.x;
            const dz = b.node.position.z - a.node.position.z;
            const d2 = dx * dx + dz * dz;
            if (d2 >= want * want) continue;
            resolved = true;
            const nx = sepAxX[k];
            const nz = sepAxZ[k];
            // b moves along the axis, a moves against it, by however much it takes to land on
            // `want` - which is the same total displacement the centre-line push used to apply
            // when the axis and the centre line agree, i.e. everywhere except deep overlap.
            const pen = pushAlong(dx, dz, nx, nz, want);
            const share = a.movable && b.movable ? 0.5 : 1;
            if (a.movable) {
              a.node.position.x -= nx * pen * share;
              a.node.position.z -= nz * pen * share;
            }
            if (b.movable) {
              b.node.position.x += nx * pen * share;
              b.node.position.z += nz * pen * share;
            }
          }
        }
        if (!resolved) break;
      }
    }

    /**
     * After every mover is placed, push any ball out of any robot it is standing inside.
     *
     * This is not a solver and does not pretend to be one: it is one shape test per ball per unit
     * - a disc against a cylindrical hull, an axis-aligned box resolved along its shallowest axis
     * against everything else - and it is a pure function of the poses at `tSec` so scrubbing
     * reproduces it exactly. What it buys is that the ball stops passing through the chassis that
     * is supposed to be dribbling it, and it visibly deflects off a robot it runs into, which
     * reads as contact.
     */
    function separateProps() {
      for (let i = 0; i < movers.length; i++) {
        const mv = movers[i];
        if (!mv.ball) continue;
        const r = mv.ballR;
        // Condition every hull axis for this ball once, off the raw tracks, for the same reason the
        // unit pass does: a dribbled ball's track runs THROUGH the robot dribbling it, so the
        // instantaneous centre line spins and the ball was being flung round the chassis at 60 mm
        // per frame - which then whipped every `face:ball` chassis with it, measured at 2594 deg/s.
        for (let u = 0; u < unitBoxes.length; u++) {
          const ub = unitBoxes[u];
          if (ub.cyl) conditionAxis(mv.axisBase + u, mv, ub, ub.r + r);
        }
        // Sweeps, and every hull in a sweep is resolved against the SAME pose and then averaged.
        //
        // Resolving them one after another means the last hull tested wins outright, and two
        // robots in contact with the ball between them are a case where no single hull's answer is
        // the answer: measured on the live def at t=42.15, the striker and the keeper were 185 mm
        // apart with the ball wedged in the gap, and the ordered pass parked it exactly on the
        // keeper's hull and 53 percent inside the striker's. Averaging the sweep's answers and
        // iterating walks it out to the point that clears both, and for the ordinary one-hull case
        // the average of one answer is that answer, so a single contact is still exact in one
        // sweep.
        let lift = 0;
        for (let sweep = 0; sweep < PROP_MAX_SWEEPS; sweep++) {
          let hits = 0;
          let sumX = 0;
          let sumZ = 0;
          for (let u = 0; u < unitBoxes.length; u++) {
            const ub = unitBoxes[u];
            // vertical overlap first: a ball is not blocked by a hovering drone or by the top of an
            // arm's reach, only by the part of the unit that is at the ball's own height
            const uy = ub.node.position.y;
            if (uy + ub.bottom > mv.node.position.y + r * 2 || uy + ub.top < mv.node.position.y) continue;
            if (ub.cyl) {
              // A round hull is round from every direction, so the box test was wrong by up to the
              // corner overhang - 41 percent of the half-width - and left the ball hanging off the
              // flank whenever it was pushed out diagonally. Same radius the unit pass uses.
              const dx = mv.node.position.x - ub.node.position.x;
              const dz = mv.node.position.z - ub.node.position.z;
              const want = ub.r + r;
              const d2 = dx * dx + dz * dz;
              if (d2 >= want * want) continue;
              const nx = -sepAxX[mv.axisBase + u];
              const nz = -sepAxZ[mv.axisBase + u];
              const pen = pushAlong(dx, dz, nx, nz, want);
              sumX += nx * pen;
              sumZ += nz * pen;
              hits++;
              // A ball squeezed against a chassis rides up its face a little rather than clipping,
              // and "a little" is a fraction of the ball, not a quarter of however deep the overlap
              // happened to be - that put a 37 mm ball 31 mm into the air. The deepest contact of
              // the frame wins, so the lift does not depend on which hull was tested last.
              lift = Math.max(lift, Math.min(pen * 0.25, r * 0.12));
              continue;
            }
            const yaw = ub.node.rotation.y;
            const c = Math.cos(yaw);
            const sn = Math.sin(yaw);
            const rx = mv.node.position.x - ub.node.position.x;
            const rz = mv.node.position.z - ub.node.position.z;
            // into the unit's own frame, where the hull is an axis-aligned box
            const lx = rx * c - rz * sn;
            const lz = rx * sn + rz * c;
            const ex = ub.halfX + r;
            const ez = ub.halfZ + r;
            const px = ex - Math.abs(lx);
            const pz = ez - Math.abs(lz);
            if (px <= 0 || pz <= 0) continue;
            let nx = 0;
            let nz = 0;
            if (px < pz) nx = lx >= 0 ? px : -px;
            else nz = lz >= 0 ? pz : -pz;
            sumX += nx * c + nz * sn;
            sumZ += -nx * sn + nz * c;
            hits++;
            lift = Math.max(lift, Math.min(Math.min(px, pz) * 0.25, r * 0.12));
          }
          if (!hits) break;
          mv.node.position.x += sumX / hits;
          mv.node.position.z += sumZ / hits;
        }
        // The ball rests ON the floor - centre at exactly one radius - unless a hull is squeezing
        // it, and even then the ride-up is a slice of the ball. Assigned once, after every hull,
        // so the height is a property of the frame rather than of the last test that ran.
        mv.node.position.y = mv.baseY + lift;
      }
    }

    /**
     * A holonomic base strafes: heading and travel are independent, and keeping the kicker face on
     * the ball while crabbing sideways is the whole visual signature of an omni drive. This runs
     * after every mover has been placed, so it aims at where the target IS this frame rather than
     * where it was last frame.
     */
    function applyFaceYaw() {
      for (let i = 0; i < faceMovers.length; i++) {
        const mv = faceMovers[i];
        const fx = mv.motion.yawNode.position.x - mv.node.position.x;
        const fz = mv.motion.yawNode.position.z - mv.node.position.z;
        if (fx * fx + fz * fz > 1e-8) mv.node.rotation.y = Math.atan2(fx, fz);
      }
    }

    /** Spread and fade every contact shadow by how far its owner is off the ground. */
    function stepShadows() {
      for (let i = 0; i < shadows.length; i++) {
        const sh = shadows[i];
        const h = Math.max(sh.node.position.y, 0);
        // the quad is a child of a node that may have lifted, so it is pushed back down to y = 0
        sh.mesh.position.y = 0.0015 - sh.node.position.y;
        const spread = 1 + h * 1.5;
        sh.mesh.scale.set(sh.sx * spread, 1, sh.sz * spread);
        sh.mesh.material.opacity = clamp(0.58 - h * 0.48, 0.05, 0.58);
        sh.mesh.visible = h < 1.8;
      }
    }

    // ---------------------------------------------------------------- camera
    const cam = spec.camera && typeof spec.camera === 'object' ? spec.camera : {};
    const camDist = clamp(nOr(cam.dist, 3.4), 0.8, 20);
    const camHeight = clamp(nOr(cam.height, 2.2), 0.2, 12);
    const focusPt = { x: 0, y: 0, z: 0 };
    let focusNode = null;
    {
      const target = typeof cam.focus === 'string' && cam.focus !== 'auto' ? root.getObjectByName(cam.focus) : null;
      if (target) {
        focusNode = target;
        // Pose the focus unit at t = 0 first, so the opening shot frames where it starts rather
        // than where it happens to have been built.
        const mover = movers.find((mv) => mv.node === target);
        if (mover) applyMotion(mover, 0, null);
        focusPt.x = target.position.x;
        focusPt.y = target.position.y;
        focusPt.z = target.position.z;
      } else if (root.children.length) {
        const box = new THREE.Box3().setFromObject(root);
        if (Number.isFinite(box.min.x) && !box.isEmpty()) {
          focusPt.x = (box.min.x + box.max.x) * 0.5 / worldScale;
          focusPt.z = (box.min.z + box.max.z) * 0.5 / worldScale;
          focusPt.y = clamp((box.max.y / worldScale) * 0.35, 0, 3);
        }
      }
    }
    const cameraHome = {
      position: {
        x: (focusPt.x + camDist * 0.62) * worldScale,
        y: camHeight * worldScale,
        z: (focusPt.z + camDist * 0.78) * worldScale,
      },
      target: {
        x: focusPt.x * worldScale,
        y: (focusPt.y + 0.25) * worldScale,
        z: focusPt.z * worldScale,
      },
    };

    // The same follow hook the two canned scenes that travel expose (drone/scene.js's
    // `cameraFocus`, rescue/scene.js's): a zero-argument function returning the WORLD point the
    // shot should stay on, read off the live posed node rather than recomputed, so it reports
    // wherever update() last put the unit. viewer.js does the rest exactly as it does for the
    // canned robots: it lerps toward the point at 0.06 a frame, snaps when the point jumps more
    // than 1.2 units (a scrub), and translates the camera AND controls.target by the same delta,
    // so the orbit the visitor dialled in survives and reset-view still means cameraHome.
    //
    // Unit positions are root-local and root carries `worldScale`, so everything is scaled on the
    // way out; the +0.25 lift is cameraHome.target's, which makes the first frame's delta exactly
    // zero instead of yanking the rig down a quarter unit.
    //
    // `focus: "auto"` (or a focus that names nothing) has no unit to chase, so the point stays the
    // scene-bbox centre the home shot was framed on: a fleet-wide establishing shot does not
    // chase anybody. The returned object is reused between calls because update() and this run in
    // viewer.js's rAF loop and neither may allocate.
    const focusOut = { x: cameraHome.target.x, y: cameraHome.target.y, z: cameraHome.target.z };

    function cameraFocus() {
      if (focusNode) {
        focusOut.x = focusNode.position.x * worldScale;
        focusOut.y = (focusNode.position.y + 0.25) * worldScale;
        focusOut.z = focusNode.position.z * worldScale;
      }
      return focusOut;
    }

    // ---------------------------------------------------------------- update
    function update(tSec, data) {
      const d = data || {};
      ensureSpinTracks(d);

      for (let i = 0; i < movers.length; i++) applyMotion(movers[i], tSec, d);
      // Order matters: units settle against each other first, then the ball is pushed out of where
      // they ENDED UP, then a `face:` yaw aims at the final pose rather than at a pre-contact one.
      tSec_ = tSec;
      separateUnits();
      separateProps();
      applyFaceYaw();
      stepShadows();
      for (let i = 0; i < envUpdaters.length; i++) envUpdaters[i](tSec);

      for (let i = 0; i < compiled.length; i++) {
        const r = compiled[i];
        const node = r.node;
        switch (r.kind) {
          case 'spin': {
            if (!r.trackT) break;
            node.rotation[r.axis] = r.baseRot + sampleAt(r.trackT, r.trackV, tSec) * r.gain;
            break;
          }
          case 'rotate': {
            const v = readField(d, r.field, tSec, 0);
            node.rotation[r.axis] = r.baseRot + clamp(v * r.gain, -Math.PI, Math.PI);
            break;
          }
          case 'tilt': {
            // attitude, not articulation: clamped so a channel in degrees leans the body instead
            // of spinning it through the floor
            const v = readField(d, r.field, tSec, 0);
            node.rotation[r.axis] = r.baseRot + clamp(v * r.gain, -0.7, 0.7);
            break;
          }
          case 'glow': {
            const v = clamp(readField(d, r.field, tSec, r.min), r.min, r.max);
            const lit = remap(v, r.min, r.max, 0, 0.9);
            for (let k = 0; k < r.glowMats.length; k++) r.glowMats[k].emissiveIntensity = lit;
            break;
          }
          case 'wobble': {
            const v = readField(d, r.field, tSec, 0);
            const amp = clamp(Math.abs(v * r.gain) * 0.02, 0, 0.06);
            node.position.x = r.baseX + Math.sin(tSec * 41.3) * amp;
            node.position.y = r.baseY + Math.sin(tSec * 57.1) * amp * 0.7;
            node.position.z = r.baseZ + Math.cos(tSec * 47.9) * amp;
            break;
          }
          default: {
            // offset
            const v = readField(d, r.field, tSec, 0);
            const base = r.axis === 'x' ? r.baseX : r.axis === 'y' ? r.baseY : r.baseZ;
            node.position[r.axis] = base + v * r.gain;
            break;
          }
        }
      }

      if (hotEntry) {
        // kept low enough that the part's own shading still reads under the pulse
        const pulse = 0.16 + Math.abs(Math.sin(tSec * 4.2)) * 0.5;
        for (let i = 0; i < hotEntry.meshes.length; i++) {
          hotEntry.meshes[i].material.emissiveIntensity = pulse;
        }
      }
    }

    // ---------------------------------------------------------------- budget audit
    // Counted per DRAWN mesh, not per geometry: the environments deliberately share one
    // geometry across dozens of meshes, and it is the draw that costs. The tier chosen from the
    // part census above is what keeps this under SCENE_CAPS.maxTriangles; the tally is measured
    // rather than trusted so the fixture harness can assert it.
    let triangles = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const idx = o.geometry.index;
      triangles += Math.round((idx ? idx.count : o.geometry.attributes.position.count) / 3);
    });

    // ---------------------------------------------------------------- rendering signals
    // viewer.js owns the renderer, so anything about EXPOSURE, environment lighting, fog, the
    // blueprint chrome or the shadow frustum is a request, not a change. The four hand-written
    // robots return no `rendering` block at all and therefore render byte-identically to before;
    // a generated scene asks for the treatment its own content needs.
    //
    // The shadow frustum is the important one. A fixed 18 m ortho on a 1024 map is 17.6 mm a
    // texel, and a 180 mm robot on 10 texels cannot cast anything a viewer would call a shadow.
    // Fitting the frustum to the play area instead is a ~35x resolution win for free.
    const play = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const mv of movers) {
      const m = mv.motion;
      if (m.kind !== 'waypoints') continue;
      for (let i = 0; i < m.n; i++) {
        if (m.xs[i] < play.minX) play.minX = m.xs[i];
        if (m.xs[i] > play.maxX) play.maxX = m.xs[i];
        if (m.zs[i] < play.minZ) play.minZ = m.zs[i];
        if (m.zs[i] > play.maxZ) play.maxZ = m.zs[i];
      }
    }
    for (const ub of unitBoxes) {
      if (ub.node.position.x < play.minX) play.minX = ub.node.position.x;
      if (ub.node.position.x > play.maxX) play.maxX = ub.node.position.x;
      if (ub.node.position.z < play.minZ) play.minZ = ub.node.position.z;
      if (ub.node.position.z > play.maxZ) play.maxZ = ub.node.position.z;
    }
    const shadowFit = Number.isFinite(play.minX) && Number.isFinite(play.minZ);
    const shadowCenter = shadowFit
      ? { x: (play.minX + play.maxX) * 0.5 * worldScale, z: (play.minZ + play.maxZ) * 0.5 * worldScale }
      : { x: 0, z: 0 };
    const shadowHalf = shadowFit
      ? clamp((Math.max(play.maxX - play.minX, play.maxZ - play.minZ) * 0.5 + 1.2) * worldScale, 1.2, 16)
      : 9;
    const fogNear = clamp(shadowHalf * 1.4, 4, 20);
    const rendering = {
      toneMap: 'aces',
      exposure: 1.08,
      env: true,
      anisotropy: true,
      // A generated environment brings its own floor, so viewer.js's 80 m ground and the two
      // blueprint grids are just a second floor showing through the seams of the first.
      grids: environment === 'grid',
      ground: environment === 'grid',
      fog: { color: fogColorOf(), near: fogNear, far: fogNear * 3.2 },
      shadow: { half: shadowHalf, center: shadowCenter, mapSize: 2048, bias: -0.0002, normalBias: 0.008 },
    };

    // Camera character, for generated scenes only. The canned demos were approved on the fixed
    // exponential chase and keep it.
    const followTuning = { omega: 4.2, lead: 0.3, snap: 1.2 };

    function dispose() {
      mount.remove(root);
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
      for (const t of textures) t.dispose();
      geoms.length = 0;
      mats.length = 0;
      textures.length = 0;
      compiled.length = 0;
      movers.length = 0;
      envUpdaters.length = 0;
      shadows.length = 0;
      unitBoxes.length = 0;
      unitDiscs.length = 0;
      parts.clear();
      hotFor.clear();
      hotEntry = null;
      highlight = null;
      // the follow hook keeps the last point it reported, but stops holding the detached unit
      focusNode = null;
    }

    return {
      update,
      setHighlight,
      dispose,
      cameraHome,
      cameraFocus,
      rendering,
      followTuning,
      /** Diagnostics for the fixture harness; viewer.js neither reads nor needs these. */
      parts,
      triangles,
      shadows,
      unitDiscs,
    };
  };
}
