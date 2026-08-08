// ssl/scene.js - the RoboCup Small Size League match replay.
//
// Nothing in here is styled from the rulebook. The field, the goals, the carpet margins, the
// line set, the centre-circle arc, the ball radius and the robot footprint all come out of the
// decoded MatchData's `geometry` block, which is the log's own SSL_GeometryData packet
// (`geometry.source` says as much). The rulebook only governs the things a log cannot carry:
// the printed vision-pattern art (see patterns.js), matte-black tops, white-inside/black-outside
// goal walls, green felt.
//
// The robot BELOW the shell is league convention too: a tracker reports a pose, a radius and a
// height, never a wheel. Modelled here is only what the rules constrain and every robot in the
// division has - four omni wheels inside the 180 mm cylinder, the flat face with a dribbler roller
// and kicker plate in it, an IMU on the top plate - never one team's hardware. The four anatomy
// labels in ssl/experience.js attach to exactly these parts.
//
// The scene is built LAZILY, on the first update() that arrives with a decoded MatchData.
// buildScene() is called by the viewer before any data exists, and match-data.js is ~700 KB, so
// importing it here would drag the whole match payload onto the picker's boot path. update() is
// where the data contract lives (`viewer.js` passes `def.getSceneData?.() ?? def.data`), so that
// is where the field gets built.
//
// Two more contracts this scene leans on, both added to viewer.js for it:
//   * `rendering.shadow === false` - a 1024^2 map over an 18 m frustum is ~18 mm/texel, which on
//     180 mm robots is a smear. Grounding comes from baked contact discs instead, and every mesh
//     here sets castShadow = false.
//   * `hudState(tSec)` - a 46 dvh follow-cam cannot show a legible scoreboard in-world, so the
//     referee state is rendered as a DOM strip. The in-world venue screen is decoration. The strip
//     carries the TeamInfo semantics whole: names, score, stage, stage_time_left, yellow/red cards,
//     max_allowed_bots, timeouts remaining, keeper id. The keeper is a HUD chip and NOT a decal on
//     the robot: a real SSL robot carries no keeper marking, the id is game-controller state.

import {
  PATTERN_DOTS,
  paintPattern,
} from './patterns.js';
import { bracket, inPlayTimes } from './in-play.js';

// ---------------------------------------------------------------------------- constants

export const ROBOT_H = 0.147; // team heights are uniform (rulebook: <= 150 mm, within 20 mm per team)
const HULL_SPLIT = 0.095; // primary hull band below, secondary above; both over 20% of the side
const DRIBBLER_FRONT = 0.0725; // flat face, 72.5 mm from centre (rulebook window 71.5-75 mm)
const ARC_SEGMENTS = 30; // below ~28 the 180 mm hull reads as a visible polygon
// The team-coloured shell starts 46 mm up, because the bottom of an SSL robot's envelope is
// MECHANISM, not bodywork: wheels, dribbler mouth and kicker plate all live in that band. A
// shell drawn to the carpet is what made these read as banded bins. Under it is a narrower chassis
// core, so the bay is open at the rim and the wheels are visible instead of tucked inside.
const BAY_H = 0.046;
const CORE_R = 0.07;
// Omni wheels: 48 mm across, 15 mm wide, hubs 78 mm out, which puts the outermost corner of the
// tread at 88.8 mm, inside the 180 mm cylinder the rules measure and clear of the hull rim. Mounts
// at +/-60 and +/-120 deg off the dribbler face, as sixths of a turn: the front pair straddles the
// mouth, which is why a real four-wheel SSL base does not sit on the diagonals.
const WHEEL_R = 0.024;
const WHEEL_W = 0.015;
const WHEEL_HUB = 0.078;
const WHEEL_SIXTHS = [1, 2, -2, -1];
// IMU board on the top plate, as close to the centre of rotation as the printed pattern allows: the
// clear gap behind the centre team dot and inboard of the two rear id dots (patterns.js has the
// geometry that gap comes out of). Nothing here may cover a dot.
const IMU_X = -0.0395;
// Where the dribbler roller sits in its robot's own frame. Exported because the anatomy overlay's
// `dribbler` anchor is this same point (ssl/experience.js).
export const DRIB_OFF_X = DRIBBLER_FRONT + 0.0035;
export const DRIB_OFF_Y = 0.028;

const Y_LINE = 0.0016;
const Y_MARK = 0.0028;
const Y_RING = 0.0034;
const Y_CONTACT = 0.0022;

const PATTERN_PX = 192;

// The 0.5 m standoff is not one rule covering every stoppage. Three commands, three affordances:
//   STOP            every robot owes the BALL 0.5 m -> the ring.
//   free kick       defenders owe the ball 0.5 m until it is IN PLAY -> the ring, retired at the
//                   derived in-play moment rather than after a fixed delay.
//   ball placement  NOT a circle on the ball: opponents owe 0.5 m to the whole ball-to-
//                   designatedPosition corridor, and it moves as the ball is dribbled there.
// HALT is a hard stop, not a standoff ("stop within 2 s"; robots keep whatever distance they had),
// and a timeout is the same, so neither gets a decal. Kickoff and penalty preparation have
// formation rules (own half, circle clear; keeper on the line, 1 m behind the ball) that are
// neither a ring nor a corridor, so the HUD state chip carries them instead.
const KEEP_OUT_RING_CMD = /^STOP$/;
const FREE_KICK_CMD = /^(DIRECT_FREE_|INDIRECT_FREE_)/;
const PLACEMENT_CMD = /^BALL_PLACEMENT_/;
const KEEP_OUT_R = 0.5; // rules: 0.5 m off the ball under STOP, and off the placement corridor
// Radius of the ball-placement target decal. NOT a rulebook number and not the 0.15 m placement
// tolerance: a legibility size for a UI mark centred on the command's designatedPosition.
const PLACE_TARGET_R = 0.12;
// Below this the ball is effectively ON the target and the corridor has collapsed to the ring the
// caps already draw, so the bands are dropped rather than rendered as a degenerate sliver.
const PLACE_CORRIDOR_MIN_M = 0.02;

// A restart command does not mean the game is running yet: in-play.js owns that derivation, and
// data.js arms the synthesized kicker on the same intervals - the HUD chip and the telemetry
// cannot disagree about when play is running.
const VIS_GHOST = 0.7; // TrackedRobot.visibility below this reads as a tracker confidence dip
// How faint a ghosted robot gets, as ACTUAL rendered opacity. The flicker below is additive around
// whatever alpha the data produced, never a second multiplier on it: multiplying compounded the
// two fades (a 0.28 hold rendered at 0.20) and pushed a held robot under the point where the top
// plate's pattern still reads, which is exactly the information a tracking-loss ghost is for.
const GHOST_ALPHA = 0.28;
const GHOST_FLICKER = 0.06;

// The shot is framed for the follow spring, not for a static wide: the viewer translates camera
// and target together, so this offset IS the follow framing. |offset| = 5.34 m puts ~3.0 m of
// context around the ball on a 390 px / 46 dvh phone (the viewer widens the fov to ~58 deg there)
// and ~4.5 m either side of it on the desktop panel. The azimuth is 18 deg off the field's long
// axis: near enough to end-on that a goal stays in shot behind the play, far enough off it that
// the pitch reads as a plane rather than a line. "reset view" recentres on the halfway line.
// Elevation is 58 deg rather than the 37 deg this shot started at, at the SAME offset length and
// the same azimuth, so the framing above is untouched and only the pitch angle changes. At 37 deg
// the band of empty dark above the far touch line was a quarter of a 1440 px stage (the carpet
// only reaches 0.3 m past that line, and there is no world behind it); at 58 deg it is about a
// tenth, without flattening the pitch into a plan view or losing the far goal on a 390 px crop.
export const cameraHome = {
  position: { x: 2.691, y: 4.60, z: 0.874 },
  target: { x: 0, y: 0.07, z: 0 },
};

/** Referee command -> the label the HUD shows, with the display name of the team it belongs to. */
function commandLabel(cmd, teams) {
  const nameOf = (c) => (teams && teams[c] && teams[c].shortName) || c;
  if (!cmd) return { label: 'UNKNOWN', tone: 'stop' };
  if (cmd === 'HALT') return { label: 'HALT', tone: 'halt' };
  if (cmd === 'STOP') return { label: 'STOP', tone: 'stop' };
  if (cmd === 'NORMAL_START' || cmd === 'FORCE_START') return { label: 'RUNNING', tone: 'live' };
  const m = /^([A-Z_]+?)_(YELLOW|BLUE)$/.exec(cmd);
  if (!m) return { label: cmd.replace(/_/g, ' '), tone: 'stop' };
  const team = nameOf(m[2].toLowerCase());
  switch (m[1]) {
    case 'DIRECT_FREE':
    case 'INDIRECT_FREE':
      return { label: `FREE KICK (${team})`, tone: 'live' };
    case 'BALL_PLACEMENT':
      return { label: `BALL PLACEMENT (${team})`, tone: 'prep' };
    case 'PREPARE_KICKOFF':
      return { label: `KICKOFF (${team})`, tone: 'prep' };
    case 'PREPARE_PENALTY':
      return { label: `PENALTY (${team})`, tone: 'prep' };
    case 'TIMEOUT':
      return { label: `TIMEOUT (${team})`, tone: 'prep' };
    case 'GOAL':
      return { label: `GOAL (${team})`, tone: 'goal' };
    default:
      return { label: `${m[1].replace(/_/g, ' ')} (${team})`, tone: 'prep' };
  }
}

/** mm:ss from the signed microsecond countdown. It freezes in stoppages and can go negative. */
function clockText(leftUs) {
  if (leftUs == null || !Number.isFinite(leftUs)) return '--:--';
  const neg = leftUs < 0;
  const s = Math.floor(Math.abs(leftUs) / 1e6);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${neg ? '-' : ''}${mm}:${ss < 10 ? '0' : ''}${ss}`;
}

/**
 * The Referee.Stage enum, compacted for a one-line strip: NORMAL_SECOND_HALF -> "2ND HALF". Only
 * the NORMAL_ prefix is dropped, because it is the default and says nothing; EXTRA_ becomes "ET "
 * and the shootout keeps its name, so an extra-time half can never read as a regulation one. A
 * stage the enum grows later falls through to its own name rather than being mislabelled.
 */
function stageLabel(stage) {
  if (!stage) return '';
  return stage
    .replace(/^NORMAL_/, '')
    .replace(/^EXTRA_/, 'ET_')
    .replace(/^PENALTY_/, '')
    .replace('FIRST', '1ST')
    .replace('SECOND', '2ND')
    .replace(/_PRE$/, '_SETUP')
    .replace(/_/g, ' ');
}

/** Last entry in a t-ascending change-only array at or before t. -1 if t precedes all of them. */
function holdIndex(arr, t) {
  let lo = 0;
  let hi = arr.length - 1;
  if (!arr.length || t < arr[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Cubic Hermite with the overshoot clamp from the export's interpolation contract (FORMAT.md
 * section 4). The clamp keeps a real braking overshoot but kills the cubic blow-up you get when a
 * sampled velocity disagrees with the sampled endpoints, which is what a tracker glitch or a kick
 * looks like in the columns.
 */
function hermite(p0, p1, v0, v1, dt, s) {
  const s2 = s * s;
  const s3 = s2 * s;
  const p =
    (2 * s3 - 3 * s2 + 1) * p0 +
    (s3 - 2 * s2 + s) * dt * v0 +
    (-2 * s3 + 3 * s2) * p1 +
    (s3 - s2) * dt * v1;
  const m = 0.5 * dt * Math.max(Math.abs(v0), Math.abs(v1));
  const lo = Math.min(p0, p1) - m;
  const hi = Math.max(p0, p1) + m;
  return p < lo ? lo : p > hi ? hi : p;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------- geometry batcher

/**
 * Accumulates untextured triangles so the whole field - carpet markings, goal shells, walls -
 * lands in a handful of draw calls instead of one per rectangle.
 */
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
/** Axis-aligned box; `faces` is a bitmask of +X 1, -X 2, +Y 4, -Y 8, +Z 16, -Z 32. */
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
/**
 * A flat strip on the carpet from SSL (x,y) p1 to p2, `w` wide, squared off at both ends.
 *
 * The packet's FieldLineSegment is a CENTRELINE: p1 and p2 are the ends of the painted line and
 * `thickness` is its width about that centreline, so the quad spans exactly p1 to p2 with the
 * thickness/2 caps INSIDE that span. Extending the ends by w/2, as this did, put 5 mm of white
 * past every touch-line corner and past both ends of every penalty stretch.
 */
Batch.prototype.stripe = function stripe(p1, p2, w, y) {
  let dx = p2[0] - p1[0];
  let dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const h = w / 2;
  const ax = p1[0];
  const ay = p1[1];
  const bx = p2[0];
  const by = p2[1];
  // perpendicular chosen so the quad winds counter-clockwise once SSL y is flipped into three z;
  // the other sign gives a downward-facing normal and the whole line set vanishes to backface cull
  const px = dy * h;
  const py = -dx * h;
  // SSL (x, y) -> three (x, y_up, -y)
  this.quad(
    [ax + px, y, -(ay + py)],
    [bx + px, y, -(by + py)],
    [bx - px, y, -(by - py)],
    [ax - px, y, -(ay - py)],
    0, 1, 0
  );
};
Batch.prototype.annulus = function annulus(cx, cy, r0, r1, a0, a1, seg, y) {
  for (let i = 0; i < seg; i++) {
    const t0 = a0 + ((a1 - a0) * i) / seg;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
    const c0 = Math.cos(t0);
    const s0 = Math.sin(t0);
    const c1 = Math.cos(t1);
    const s1 = Math.sin(t1);
    this.quad(
      [cx + r0 * c0, y, -(cy + r0 * s0)],
      [cx + r1 * c0, y, -(cy + r1 * s0)],
      [cx + r1 * c1, y, -(cy + r1 * s1)],
      [cx + r0 * c1, y, -(cy + r0 * s1)],
      0, 1, 0
    );
  }
};
Batch.prototype.disc = function disc(cx, cy, r, seg, y) {
  for (let i = 0; i < seg; i++) {
    const t0 = (Math.PI * 2 * i) / seg;
    const t1 = (Math.PI * 2 * (i + 1)) / seg;
    this.tri(
      cx, y, -cy,
      cx + r * Math.cos(t0), y, -(cy + r * Math.sin(t0)),
      cx + r * Math.cos(t1), y, -(cy + r * Math.sin(t1)),
      0, 1, 0
    );
  }
};
/**
 * Fold a three geometry into this batch, so the round parts of a robot (wheels, the dribbler
 * roller, the chassis core) can be authored as cylinders and still land in one buffer with the
 * boxes. The source is transformed and thrown away here: it is never uploaded, so there is nothing
 * to dispose, and what the scene keeps is the merged result.
 */
Batch.prototype.mesh = function mesh(src) {
  const g = src.index ? src.toNonIndexed() : src;
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  for (let i = 0; i < p.length; i++) {
    this.p.push(p[i]);
    this.n.push(n[i]);
  }
};
Batch.prototype.build = function build(THREE) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
  return g;
};

// ---------------------------------------------------------------------------- felt textures

/** Green felt: matte, with a fine fibre grain in the normal and a slow mottle in the albedo. */
function feltTextures(THREE) {
  const N = 256;
  const doc = document;
  const noise = new Float32Array(N * N);
  // value noise, tileable: two octaves of a hashed lattice
  const hash = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const lat = (cells, amp, out) => {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const fx = (i / N) * cells;
        const fy = (j / N) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = hash((x0 % cells + cells) % cells, (y0 % cells + cells) % cells);
        const b = hash(((x0 + 1) % cells + cells) % cells, (y0 % cells + cells) % cells);
        const c = hash((x0 % cells + cells) % cells, ((y0 + 1) % cells + cells) % cells);
        const d = hash(((x0 + 1) % cells + cells) % cells, ((y0 + 1) % cells + cells) % cells);
        out[j * N + i] += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amp;
      }
    }
  };
  lat(64, 0.6, noise);
  lat(16, 0.3, noise);
  lat(4, 0.1, noise);

  const mk = (paint) => {
    const c = doc.createElement('canvas');
    c.width = N;
    c.height = N;
    const img = c.getContext('2d').createImageData(N, N);
    paint(img.data);
    c.getContext('2d').putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    return t;
  };

  const map = mk((d) => {
    for (let i = 0; i < N * N; i++) {
      const v = noise[i] - 0.5;
      d[i * 4] = 26 + v * 22;
      d[i * 4 + 1] = 84 + v * 34;
      d[i * 4 + 2] = 46 + v * 22;
      d[i * 4 + 3] = 255;
    }
  });
  map.colorSpace = THREE.SRGBColorSpace;

  const rough = mk((d) => {
    for (let i = 0; i < N * N; i++) {
      const v = 224 + (noise[i] - 0.5) * 46;
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
  });

  const normal = mk((d) => {
    const at = (i, j) => noise[((j + N) % N) * N + ((i + N) % N)];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const dx = (at(i + 1, j) - at(i - 1, j)) * 2.4;
        const dy = (at(i, j + 1) - at(i, j - 1)) * 2.4;
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

/** Soft round contact patch, so a shadowless robot still sits ON the carpet. */
function contactTexture(THREE) {
  const N = 64;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.52, 'rgba(255,255,255,0.72)');
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
  root.name = 'ssl-root';
  mount.add(root);

  const disposables = [];
  const keep = (o) => {
    disposables.push(o);
    return o;
  };

  let D = null; // decoded MatchData, once update() hands it over
  let built = false;
  let robots = [];
  let ball = null;
  let ballRing = null;
  let keepOut = null;
  let placeTarget = null;
  let placeCorridor = null;
  let placeCorridorBands = null;
  let placeCorridorFarCap = null;
  let halo = null;
  let contacts = null;
  let venue = null;
  let venueDraw = null;
  let heroFocus = null;
  /** Focus point of the most recent update(), so a no-arg cameraFocus() reports the posed moment. */
  let lastFocus = null;
  /** Per command index: the time the ball came into play, or null if it is not a restart. */
  let inPlay = [];
  let highlight = null;
  let hot = null; // the highlighted robot, resolved once per setHighlight, never per frame

  const dummy = new THREE.Object3D();
  const focusOut = { x: 0, y: 0.06, z: 0 };
  const hud = {
    version: '',
    teams: [
      { name: '', color: 'yellow', score: 0, cards: 0, reds: 0, maxBots: null, keeper: null, timeouts: null },
      { name: '', color: 'blue', score: 0, cards: 0, reds: 0, maxBots: null, keeper: null, timeouts: null },
    ],
    state: { label: '', tone: 'stop' },
    clock: '--:--',
    stage: '',
  };

  // ------------------------------------------------------------------ the field

  function buildField(geo) {
    const halfL = geo.fieldLength / 2;
    const halfW = geo.fieldWidth / 2;
    const bx = geo.boundaryWidthGoalLine != null ? geo.boundaryWidthGoalLine : geo.boundaryWidth;
    const by = geo.boundaryWidth;
    const carpetL = geo.fieldLength + 2 * bx;
    const carpetW = geo.fieldWidth + 2 * by;

    // ---- carpet
    const felt = feltTextures(THREE);
    keep(felt.map);
    keep(felt.rough);
    keep(felt.normal);
    [felt.map, felt.rough, felt.normal].forEach((t) => t.repeat.set(carpetL / 0.34, carpetW / 0.34));
    const carpetMat = keep(
      new THREE.MeshStandardMaterial({
        map: felt.map,
        roughnessMap: felt.rough,
        normalMap: felt.normal,
        roughness: 1.0,
        metalness: 0.0,
      })
    );
    carpetMat.normalScale.set(0.35, 0.35);
    const carpetGeo = keep(new THREE.PlaneGeometry(carpetL, carpetW));
    const carpet = new THREE.Mesh(carpetGeo, carpetMat);
    carpet.rotation.x = -Math.PI / 2;
    carpet.castShadow = false;
    carpet.receiveShadow = false;
    carpet.name = 'carpet';
    root.add(carpet);

    // ---- markings: exactly the exported line set + the exported arc, at the exported thickness
    const lines = new Batch();
    (geo.fieldLines || []).forEach((l) => {
      lines.stripe(l.p1, l.p2, l.thickness || geo.lineThickness || 0.01, Y_LINE);
    });
    (geo.fieldArcs || []).forEach((a) => {
      const th = a.thickness || geo.lineThickness || 0.01;
      lines.annulus(a.center[0], a.center[1], a.radius - th / 2, a.radius + th / 2, a.a1, a.a2, 96, Y_LINE);
    });
    // penalty marks: goalCenterToPenaltyMark measured from the OPPONENT goal centre
    if (geo.goalCenterToPenaltyMark) {
      const px = geo.goalCenterToPenaltyMark - halfL;
      [px, -px].forEach((x) => lines.disc(x, 0, 0.03, 16, Y_MARK));
    }
    const lineMat = keep(
      new THREE.MeshStandardMaterial({ color: 0xf2f4f5, roughness: 0.88, metalness: 0.0 })
    );
    const lineMesh = new THREE.Mesh(keep(lines.build(THREE)), lineMat);
    lineMesh.castShadow = false;
    lineMesh.name = 'field-lines';
    root.add(lineMesh);

    // ---- goals: white inside, black outside / edges / top; 20 mm walls
    const gw = geo.goalWidth;
    const gd = geo.goalDepth;
    const gh = geo.goalHeight;
    const wall = 0.02;
    const shell = new Batch();
    const inner = new Batch();
    const walls = new Batch();
    [-1, 1].forEach((side) => {
      const mouth = side * halfL; // three x of the goal line
      const back = side * (halfL + gd);
      const cxBack = back + (side * wall) / 2;
      // back panel (black shell; the white inner face is a separate skin below)
      shell.box(cxBack, gh / 2, 0, wall, gh, gw + 2 * wall, 63);
      inner.box(mouth + side * (gd - 0.0006), gh / 2, 0, 0.0012, gh - 0.001, gw, 63);
      [-1, 1].forEach((s2) => {
        const cz = s2 * (gw / 2 + wall / 2);
        shell.box(mouth + (side * gd) / 2, gh / 2, cz, gd, gh, wall, 63);
        inner.box(mouth + (side * gd) / 2, gh / 2, cz - s2 * (wall / 2 + 0.0006), gd - 0.001, gh - 0.001, 0.0012, 63);
        // the goal side walls carry on outward to the perimeter wall
        const outerX = side * (halfL + bx);
        const runLen = Math.abs(outerX - back);
        if (runLen > 0.01) {
          walls.box(back + (side * runLen) / 2, gh / 2, cz, runLen, gh, wall, 63);
        }
      });
    });
    const blackMat = keep(
      new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.72, metalness: 0.06 })
    );
    // The viewer's fill light is blue and comes from -x, so the far goal's inner faces get only
    // that fill and read as a blue goal. A little self-illumination keeps "white inside" true from
    // both ends without reaching into the viewer's light rig.
    const whiteMat = keep(
      new THREE.MeshStandardMaterial({
        color: 0xf4f6f7,
        roughness: 0.68,
        metalness: 0.0,
        emissive: 0xf4f6f7,
        emissiveIntensity: 0.16,
      })
    );
    const goalShell = new THREE.Mesh(keep(shell.build(THREE)), blackMat);
    goalShell.castShadow = false;
    goalShell.name = 'goals';
    root.add(goalShell);
    const goalInner = new THREE.Mesh(keep(inner.build(THREE)), whiteMat);
    goalInner.castShadow = false;
    root.add(goalInner);

    // ---- perimeter wall at the carpet edge. Height is NOT in the geometry packet; 100 mm is
    // venue dressing, everything load-bearing about it (its position) is packet-derived.
    const WALL_H = 0.1;
    const wt = 0.02;
    walls.box(0, WALL_H / 2, -(carpetW / 2 + wt / 2), carpetL + 2 * wt, WALL_H, wt, 63);
    walls.box(0, WALL_H / 2, carpetW / 2 + wt / 2, carpetL + 2 * wt, WALL_H, wt, 63);
    walls.box(-(carpetL / 2 + wt / 2), WALL_H / 2, 0, wt, WALL_H, carpetW, 63);
    walls.box(carpetL / 2 + wt / 2, WALL_H / 2, 0, wt, WALL_H, carpetW, 63);
    const wallMat = keep(
      new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.8, metalness: 0.1 })
    );
    const wallMesh = new THREE.Mesh(keep(walls.build(THREE)), wallMat);
    wallMesh.castShadow = false;
    wallMesh.name = 'walls';
    root.add(wallMesh);

    return { halfL, halfW, carpetL, carpetW };
  }

  // ------------------------------------------------------------------ the robots

  function hullShape(radius, cut) {
    const th = Math.acos(Math.min(1, cut / radius));
    const s = new THREE.Shape();
    s.moveTo(cut, radius * Math.sin(th));
    s.absarc(0, 0, radius, th, Math.PI * 2 - th, false);
    s.lineTo(cut, -radius * Math.sin(th));
    s.closePath();
    return s;
  }

  /**
   * Everything that is neither the team-coloured shell nor the printed top plate, in the robot's
   * own frame (+x the dribbler face, +y up). Two geometries, built once and shared by all nineteen:
   * `dark` is the chassis core, the four tyres, the dribbler cheeks and its roller and the IMU
   * board; `metal` is the machined aluminium (wheel hubs, the kicker plate standing in the mouth,
   * the IMU's chip), which is also what a black tyre needs beside it to read as a wheel at all.
   * Only the MATERIALS are per robot: a ghost fade or a highlight may not leak onto a team-mate.
   */
  function mechanics() {
    const dark = new Batch();
    const metal = new Batch();
    const cyl = (r, len, seg) => new THREE.CylinderGeometry(r, r, len, seg);
    dark.mesh(cyl(CORE_R, BAY_H, 22).translate(0, BAY_H / 2, 0));
    // Wheel and hub share one mount, so the machined hub reads as a hub and a black tyre in a
    // shadowed bay still reads as a wheel. Under the rim there is no other light to catch.
    WHEEL_SIXTHS.forEach((k) => {
      const a = (k * Math.PI) / 3;
      const mount = (g) =>
        g
          .rotateZ(Math.PI / 2)
          .rotateY(a)
          .translate(WHEEL_HUB * Math.cos(a), WHEEL_R, -WHEEL_HUB * Math.sin(a));
      dark.mesh(mount(cyl(WHEEL_R, WHEEL_W, 10)));
      metal.mesh(mount(cyl(0.0105, WHEEL_W + 0.002, 8)));
    });
    // The mouth: two mounting cheeks with the 66 mm roller across them, then the flat kicker plate
    // behind it at ball height (a 43 mm ball sits at 21.5 mm). Cheek corners sit at 89.5 mm and the
    // roller's own surface at 89.8 mm, both inside the same 180 mm cylinder.
    [1, -1].forEach((s) => dark.box(0.0655, 0.027, s * 0.0375, 0.027, 0.038, 0.009));
    dark.mesh(cyl(0.0075, 0.066, 8).rotateX(Math.PI / 2).translate(DRIB_OFF_X, DRIB_OFF_Y, 0));
    metal.box(0.0695, 0.027, 0, 0.005, 0.034, 0.054);
    dark.box(IMU_X, ROBOT_H + 0.0025, 0, 0.026, 0.0035, 0.022);
    metal.box(IMU_X, ROBOT_H + 0.0047, 0, 0.011, 0.004, 0.009);
    return { dark: keep(dark.build(THREE)), metal: keep(metal.build(THREE)) };
  }

  function buildRobots(data) {
    const R = data.geometry.maxRobotRadius || 0.09;
    const shape = hullShape(R, DRIBBLER_FRONT);
    const mech = mechanics();
    // shape x = forward, shape y = left; extruded along +z then laid flat, so shape y -> world -z
    const mkBand = (h0, h1) => {
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: h1 - h0,
        bevelEnabled: false,
        curveSegments: ARC_SEGMENTS,
      });
      g.rotateX(-Math.PI / 2);
      g.translate(0, h0, 0);
      return keep(g);
    };
    const geoLo = mkBand(BAY_H, HULL_SPLIT);
    const geoHi = mkBand(HULL_SPLIT, ROBOT_H);
    const plateGeo = keep(new THREE.PlaneGeometry(2 * R, 2 * R));
    plateGeo.rotateX(-Math.PI / 2);
    plateGeo.translate(0, ROBOT_H + 0.0007, 0);

    const contactTex = keep(contactTexture(THREE));
    const contactGeo = keep(new THREE.PlaneGeometry(R * 2.9, R * 2.9));
    contactGeo.rotateX(-Math.PI / 2);
    contactGeo.translate(0, Y_CONTACT, 0);
    const contactMat = keep(
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: contactTex,
        transparent: true,
        opacity: 0.46,
        depthWrite: false,
      })
    );

    const out = [];
    const n = data.robots.length;
    contacts = new THREE.InstancedMesh(contactGeo, contactMat, n);
    contacts.frustumCulled = false;
    contacts.castShadow = false;
    contacts.renderOrder = 1;
    root.add(contacts);

    data.robots.forEach((rb, i) => {
      const team = rb.team || (data.teams && data.teams[rb.refereeColor]) || {};
      const hullBright = (team.hull && team.hull.bright) || '#c8c8c8';
      const hullDark = (team.hull && team.hull.dark) || '#303030';
      const primary = team.hullTonePrimary === 'dark' ? hullDark : hullBright;
      const secondary = team.hullTonePrimary === 'dark' ? hullBright : hullDark;

      const g = new THREE.Group();
      g.name = `bot_${rb.refereeColor[0]}${rb.id}`;
      root.add(g);

      // Per-robot materials: highlight writes emissive and the tracking treatments write opacity,
      // and neither may leak onto a team-mate. The mechanics get their own pair for the same reason
      // and go in `mats` below, which is what fades a ghosting robot whole rather than leaving it a
      // solid black roller in front of a hull at 0.28.
      const mat = (color, rough, metal) =>
        keep(
          new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: 0 })
        );
      const matLo = mat(primary, 0.44, 0.34);
      const matHi = mat(secondary, 0.5, 0.28);
      const matDark = mat(0x22262b, 0.58, 0.3);
      const matMetal = mat(0xbfc5cb, 0.34, 0.55);
      const lo = new THREE.Mesh(geoLo, matLo);
      const hi = new THREE.Mesh(geoHi, matHi);
      g.add(lo, hi, new THREE.Mesh(mech.dark, matDark), new THREE.Mesh(mech.metal, matMetal));

      const tex = new THREE.CanvasTexture(
        paintPattern(document, rb.id, rb.refereeColor, R, DRIBBLER_FRONT, PATTERN_PX)
      );
      tex.colorSpace = THREE.SRGBColorSpace;
      keep(tex);
      const matPlate = keep(
        new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.94,
          metalness: 0.0,
          alphaTest: 0.5,
        })
      );
      const plate = new THREE.Mesh(plateGeo, matPlate);
      g.add(plate);

      // A ghosting robot loses its solid read, so the top rim is drawn as a line the moment the
      // tracker stops being sure about it. Built only where the data says it can happen.
      // same threshold update() ghosts at, so a robot never needs an outline it was not built one for
      const canFade = (rb.absences && rb.absences.length) || (rb.dips && rb.dips.length);
      let outline = null;
      if (canFade) {
        const pts = [];
        const th = Math.acos(DRIBBLER_FRONT / R);
        for (let k = 0; k <= ARC_SEGMENTS; k++) {
          const a = th + ((Math.PI * 2 - 2 * th) * k) / ARC_SEGMENTS;
          pts.push(R * Math.cos(a), ROBOT_H + 0.002, -R * Math.sin(a));
        }
        pts.push(DRIBBLER_FRONT, ROBOT_H + 0.002, -R * Math.sin(th));
        const og = keep(new THREE.BufferGeometry());
        og.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const om = keep(
          new THREE.LineBasicMaterial({ color: 0x8fb4e8, transparent: true, opacity: 0 })
        );
        outline = new THREE.LineLoop(og, om);
        outline.visible = false;
        g.add(outline);
      }

      out.push({
        def: rb,
        key: g.name,
        group: g,
        mats: [matLo, matHi, matPlate, matDark, matMetal],
        outline,
        alpha: 1,
        visible: true,
        // Index of this robot's FIRST tracked sample, or -1 if the payload never tracked it.
        // The decoder hold-fills a pose across every absent sample INCLUDING the ones before a
        // robot's first fix, where there is no earlier value to hold: those read back as (0, 0),
        // which is the centre spot. Posing a robot there is a fabricated pose, not a gap, so
        // update() keeps it hidden until the data has an actual fix for it. A robot with no
        // presence run at all is hidden for the whole payload. The exporter already omits those
        // from a variant's roster (FORMAT.md 2.4); this is the second line, so a future payload
        // that carries one cannot put a phantom robot on the centre spot.
        firstPresent: rb.runs && rb.runs.length ? rb.runs[0][0] : -1,
      });
    });
    return out;
  }

  // ------------------------------------------------------------------ ball + UI affordances

  function buildBall(geo) {
    const r = geo.ballRadius || 0.0215;
    const g = keep(new THREE.SphereGeometry(r, 16, 12));
    const m = keep(
      new THREE.MeshStandardMaterial({
        color: 0xff6a12,
        roughness: 0.42,
        metalness: 0.0,
        emissive: 0x270a00,
        emissiveIntensity: 1,
      })
    );
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = false;
    mesh.name = 'ball';
    root.add(mesh);

    // Honest broadcast marker: a soft emissive ring painted on the felt under the ball. It is
    // plainly a UI affordance - it never leaves the ground plane and never touches the ball.
    // 224 mm across the outer edge (r*3.4 to r*5.2 on a 43 mm ball, so a 185 mm mid-band), and it
    // opens to x1.7 on a chip: findable from the follow-cam's 5 m without ever being mistaken for
    // a robot, which is 180 mm.
    const rg = keep(new THREE.RingGeometry(r * 3.4, r * 5.2, 44));
    rg.rotateX(-Math.PI / 2);
    const rm = keep(
      new THREE.MeshBasicMaterial({
        color: 0xff8a3d,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // reads as light on the felt, not as paint
        side: THREE.DoubleSide,
      })
    );
    const ring = new THREE.Mesh(rg, rm);
    ring.position.y = Y_RING;
    ring.renderOrder = 2;
    root.add(ring);

    // Ball-placement target: the referee command's own `designatedPosition`. Same honest-UI
    // language as the keep-out ring below - additive light on the felt, never a marking a real
    // pitch has - and drawn ONLY while a BALL_PLACEMENT_ command stands, because outside one the
    // field has no designated point. A 0.24 m ring with a crosshair through it.
    const tRing = keep(new THREE.RingGeometry(PLACE_TARGET_R - 0.007, PLACE_TARGET_R + 0.007, 56));
    tRing.rotateX(-Math.PI / 2);
    const cross = new Batch();
    const armIn = PLACE_TARGET_R * 0.34;
    const armOut = PLACE_TARGET_R * 1.5;
    const armW = 0.012;
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      cross.stripe([ax * armIn, ay * armIn], [ax * armOut, ay * armOut], armW, 0);
    }
    const tm = keep(
      new THREE.MeshBasicMaterial({
        color: 0x9fd0ff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    const target = new THREE.Group();
    const tr = new THREE.Mesh(tRing, tm);
    tr.renderOrder = 2;
    target.add(tr);
    const tc = new THREE.Mesh(keep(cross.build(THREE)), tm);
    tc.renderOrder = 2;
    target.add(tc);
    target.position.y = Y_RING - 0.0002;
    target.name = 'placement-target';
    target.visible = false;
    root.add(target);

    // The 0.5 m ring the robots owe the BALL. STOP, and a free kick until the ball is in play.
    const kg = keep(new THREE.RingGeometry(KEEP_OUT_R - 0.006, KEEP_OUT_R + 0.006, 72));
    kg.rotateX(-Math.PI / 2);
    const km = keep(
      new THREE.MeshBasicMaterial({
        color: 0x9fd0ff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    const ko = new THREE.Mesh(kg, km);
    ko.position.y = Y_RING - 0.0004;
    ko.renderOrder = 2;
    ko.name = 'keep-out';
    ko.visible = false;
    root.add(ko);

    // The placement corridor: the 0.5 m stadium around the ball-to-designatedPosition segment that
    // the opponents have to stay out of. Built once in a canonical frame (axis along local +x from
    // 0 to 1) and posed per frame with a position, a Y rotation and one scale on the bands, so a
    // shape that changes length and direction every frame costs no allocation.
    const capA = new Batch(); // ball-end cap: the half opening backwards, local -x
    capA.annulus(0, 0, KEEP_OUT_R - 0.006, KEEP_OUT_R + 0.006, Math.PI / 2, (3 * Math.PI) / 2, 40, 0);
    const capB = new Batch(); // target-end cap
    capB.annulus(0, 0, KEEP_OUT_R - 0.006, KEEP_OUT_R + 0.006, -Math.PI / 2, Math.PI / 2, 40, 0);
    const bands = new Batch(); // the two straights, unit length, scaled in x to the real length
    bands.stripe([0, KEEP_OUT_R], [1, KEEP_OUT_R], 0.012, 0);
    bands.stripe([0, -KEEP_OUT_R], [1, -KEEP_OUT_R], 0.012, 0);
    const cm = keep(
      new THREE.MeshBasicMaterial({
        color: 0x9fd0ff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    const corridor = new THREE.Group();
    const cA = new THREE.Mesh(keep(capA.build(THREE)), cm);
    const cB = new THREE.Mesh(keep(capB.build(THREE)), cm);
    const cBand = new THREE.Mesh(keep(bands.build(THREE)), cm);
    cA.renderOrder = 2;
    cB.renderOrder = 2;
    cBand.renderOrder = 2;
    corridor.add(cA, cB, cBand);
    corridor.position.y = Y_RING - 0.0004;
    corridor.name = 'placement-corridor';
    corridor.visible = false;
    root.add(corridor);

    // Highlight halo, parked under whichever robot a finding points at.
    const hg = keep(new THREE.RingGeometry(0.105, 0.155, 40));
    hg.rotateX(-Math.PI / 2);
    const hm = keep(
      new THREE.MeshBasicMaterial({
        color: 0xff5f57,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const h = new THREE.Mesh(hg, hm);
    h.position.y = Y_RING + 0.0004;
    h.renderOrder = 3;
    h.visible = false;
    root.add(h);

    return { mesh, ring, ko, target, h, corridor, corridorBandMesh: cBand, corridorFarCap: cB };
  }

  /** Venue screen beyond the far touchline. Decoration: the DOM strip is the source of truth. */
  function buildVenue(data, dims) {
    const W = 512;
    const H = 160;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const tex = keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = keep(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const geo = keep(new THREE.PlaneGeometry(2.6, 0.8125));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0.86, -(dims.carpetW / 2 + 0.55));
    mesh.castShadow = false;
    root.add(mesh);

    const frame = new Batch();
    frame.box(0, 0.86, -(dims.carpetW / 2 + 0.58), 2.78, 0.95, 0.06, 63);
    frame.box(0, 0.22, -(dims.carpetW / 2 + 0.58), 0.16, 0.78, 0.16, 63);
    const fm = keep(new THREE.MeshStandardMaterial({ color: 0x121417, roughness: 0.9 }));
    const fmesh = new THREE.Mesh(keep(frame.build(THREE)), fm);
    fmesh.castShadow = false;
    root.add(fmesh);

    const draw = (st) => {
      g.fillStyle = '#0c0d0f';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, H - 3, W, 3);
      g.textBaseline = 'middle';
      g.font = '600 26px ui-monospace, monospace';
      g.fillStyle = 'rgba(255,255,255,0.62)';
      g.textAlign = 'left';
      g.fillText(st.teams[0].name.toUpperCase(), 26, 46);
      g.textAlign = 'right';
      g.fillText(st.teams[1].name.toUpperCase(), W - 26, 46);
      g.font = '700 62px ui-monospace, monospace';
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.fillText(`${st.teams[0].score} : ${st.teams[1].score}`, W / 2, 62);
      g.font = '500 24px ui-monospace, monospace';
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText(`${st.clock}   ${st.state.label}`, W / 2, 124);
      tex.needsUpdate = true;
    };
    return { draw };
  }

  // ------------------------------------------------------------------ lazy build

  function build(data) {
    D = data;
    // Absences live at the top of MatchData (verbatim from META), so pin each one onto its robot
    // once, and note the worst tracker confidence that robot ever gets - between them they decide
    // which robots need their own transparent materials and an outline to ghost with.
    data.robots.forEach((rb) => {
      const mine = (a) => a.refereeColor === rb.refereeColor && a.id === rb.id;
      rb.absences = (data.absences || []).filter(mine);
      // The exporter already decided which visibility troughs are SUSTAINED dips rather than the
      // one-sample wobble every tracked robot shows (14 of the 19 here touch 0.6 at some point).
      // Ghosting off its list keeps the shimmer on the two real events instead of on the noise.
      rb.dips = (data.visibilityDips || []).filter(mine);
    });
    const dims = buildField(data.geometry);
    robots = buildRobots(data);
    const b = buildBall(data.geometry);
    ball = b.mesh;
    ballRing = b.ring;
    keepOut = b.ko;
    placeTarget = b.target;
    placeCorridor = b.corridor;
    placeCorridorBands = b.corridorBandMesh;
    placeCorridorFarCap = b.corridorFarCap;
    halo = b.h;
    venue = buildVenue(data, dims);
    venueDraw = '';
    // hero focus: the goal build-up. See T_HERO in the scene notes.
    heroFocus = sampleFocus(heroTime(), { x: 0, y: 0 });
    inPlay = computeInPlay();
    built = true;
    root.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    if (highlight) applyHighlight();
  }

  /**
   * The hero moment. Anchored on the exported referee track rather than a hand-picked second:
   * the window's one confirmed goal crossed at `goals[0].tBallCrossing`, and the shot wants the
   * build-up rather than the aftermath, so it sits a beat before the crossing.
   */
  function heroTime() {
    const g = D.referee && D.referee.goals && D.referee.goals[0];
    if (g && Number.isFinite(g.tBallCrossing)) return Math.max(0, g.tBallCrossing - 2.3);
    return (D.durationS || 0) * 0.3;
  }

  // ------------------------------------------------------------------ sampling

  const focusScratch = { x: 0, y: 0 };
  const posedFocus = { x: 0, y: 0 };
  function sampleFocus(t, out) {
    const f = D.focus;
    const tr = D.tRobot;
    const j = bracket(tr, t);
    const j1 = Math.min(j + 1, tr.length - 1);
    const dt = tr[j1] - tr[j];
    const s = dt > 1e-6 ? clamp01((t - tr[j]) / dt) : 0;
    const o = out || focusScratch;
    o.x = f.x[j] + (f.x[j1] - f.x[j]) * s;
    o.y = f.y[j] + (f.y[j1] - f.y[j]) * s;
    return o;
  }

  // ------------------------------------------------------------------ per-frame

  function update(tSec, data) {
    if (!built) {
      if (!data || !data.robots || !data.geometry || !data.tRobot || !data.ball) return;
      build(data);
    }
    const t = Number.isFinite(tSec) ? tSec : 0;
    lastFocus = sampleFocus(t, posedFocus);

    // ---- robots, on the robot grid
    const tr = D.tRobot;
    const j = bracket(tr, t);
    const j1 = Math.min(j + 1, tr.length - 1);
    const dtR = tr[j1] - tr[j];
    const sR = dtR > 1e-4 ? clamp01((t - tr[j]) / dtR) : 1;

    for (let i = 0; i < robots.length; i++) {
      const r = robots[i];
      const rb = r.def;
      // Nothing tracked yet: there is no pose to draw, only a hold-filled zero. Hide the whole
      // robot rather than stand it on the centre spot, and clear its instanced contact patch so a
      // stale matrix does not leave one behind at the origin.
      if (r.firstPresent < 0 || j < r.firstPresent) {
        if (r.group.visible) r.group.visible = false;
        if (r.outline) r.outline.visible = false;
        r.visible = false;
        dummy.position.set(0, 0, 0);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        contacts.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const both = rb.present[j] === 1 && rb.present[j1] === 1 && j1 !== j;
      let x;
      let y;
      let yaw;
      if (both && dtR > 1e-4) {
        x = hermite(rb.x[j], rb.x[j1], rb.vx[j], rb.vx[j1], dtR, sR);
        y = hermite(rb.y[j], rb.y[j1], rb.vy[j], rb.vy[j1], dtR, sR);
        // the exported yaw is continuous/unwrapped, so no shortest-arc logic here, by contract
        yaw = hermite(rb.yaw[j], rb.yaw[j1], rb.w[j], rb.w[j1], dtR, sR);
      } else {
        // Two reasons land here and they read DIFFERENT samples (FORMAT.md 4.1, 4.2): an absent
        // endpoint holds the last tracked pose at j, but a degenerate interval (the producer's
        // back-to-back frame pair) snaps to the LATER sample, both being good fixes.
        const jj = both && dtR <= 1e-4 ? j1 : j;
        x = rb.x[jj];
        y = rb.y[jj];
        yaw = rb.yaw[jj];
      }

      // ---- tracking treatment
      let alpha = 1;
      let ghost = false;
      if (rb.present[j] !== 1) {
        const ab = absenceAt(rb, t);
        const age = ab ? t - ab.t : 0;
        if (ab && ab.class === 'substitution') {
          // affirmative game-controller substitution evidence: this one may leave the field
          alpha = 1 - clamp01(age / 0.6);
        } else {
          // unknown / tracking-loss: hold the last tracked pose as a ghost. Never claim it left.
          alpha = 1 - (1 - GHOST_ALPHA) * clamp01(age / 0.6);
          ghost = true;
        }
      } else {
        // Inside one of this robot's real visibility dips the ghost depth tracks the instantaneous
        // tracker confidence, so the shimmer is the data and not a canned animation.
        if (rb.dips && rb.dips.length && spanAt(rb.dips, t)) {
          const v = rb.vis ? rb.vis[j] : 1;
          alpha = GHOST_ALPHA + (1 - GHOST_ALPHA) * clamp01((v - 0.05) / (VIS_GHOST - 0.05));
          ghost = true;
        }
      }
      if (ghost) {
        // signal-lost flicker: two beat frequencies so it never reads as a clean sine, ADDED
        // around the alpha above rather than multiplied into it (see GHOST_FLICKER)
        alpha = clamp01(
          alpha + GHOST_FLICKER * (Math.abs(Math.sin(t * 11.7) * Math.sin(t * 3.1)) - 0.5),
        );
      }

      const show = alpha > 0.012;
      if (r.group.visible !== show) r.group.visible = show;
      if (show) {
        r.group.position.set(x, 0, -y);
        r.group.rotation.y = yaw;
      }
      if (r.alpha !== alpha) {
        r.alpha = alpha;
        const opaque = alpha > 0.995;
        for (let k = 0; k < r.mats.length; k++) {
          const m = r.mats[k];
          m.transparent = !opaque;
          m.opacity = alpha;
          m.depthWrite = opaque;
          // The top plate cuts its round silhouette out of a square quad with alphaTest, and the
          // test runs on map.a * opacity - so a fading robot would cross the threshold everywhere
          // at once and lose its whole vision pattern. Track the threshold down with the fade, and
          // never to zero: alphaTest === 0 flips a shader define and forces a recompile.
          if (m.alphaTest) m.alphaTest = Math.max(0.02, 0.45 * alpha);
        }
      }
      if (r.outline) {
        const on = ghost && show;
        r.outline.visible = on;
        if (on) r.outline.material.opacity = 0.35 + 0.35 * (1 - alpha);
      }
      r.visible = show;

      dummy.position.set(x, 0, -y);
      dummy.scale.setScalar(show ? 0.5 + 0.5 * alpha : 0);
      dummy.updateMatrix();
      contacts.setMatrixAt(i, dummy.matrix);
    }
    contacts.instanceMatrix.needsUpdate = true;

    // ---- ball, on its own (much finer) grid, with z for chips
    const tb = D.tBall;
    const k0 = bracket(tb, t);
    const k1 = Math.min(k0 + 1, tb.length - 1);
    const dtB = tb[k1] - tb[k0];
    const sB = dtB > 1e-4 ? clamp01((t - tb[k0]) / dtB) : 1;
    const B = D.ball;
    const bBoth = B.present[k0] === 1 && B.present[k1] === 1 && k1 !== k0 && sameSegment(k0, k1);
    let bx;
    let by;
    let bz;
    if (bBoth && dtB > 1e-4) {
      bx = hermite(B.x[k0], B.x[k1], B.vx[k0], B.vx[k1], dtB, sB);
      by = hermite(B.y[k0], B.y[k1], B.vy[k0], B.vy[k1], dtB, sB);
      bz = hermite(B.z[k0], B.z[k1], B.vz[k0], B.vz[k1], dtB, sB);
    } else {
      // same split as the robots: hold at k0 across a gap, snap to k1 across a degenerate interval
      const kk = bBoth && dtB <= 1e-4 ? k1 : k0;
      bx = B.x[kk];
      by = B.y[kk];
      bz = B.z[kk];
    }
    const r0 = D.geometry.ballRadius || 0.0215;
    ball.position.set(bx, Math.max(bz, 0) + r0, -by);
    ball.visible = B.present[k0] === 1;
    ballRing.position.set(bx, Y_RING, -by);
    ballRing.visible = ball.visible;
    // the marker breathes, and opens up when the ball is airborne so a chip still reads on the floor
    const lift = clamp01(bz / 0.25);
    ballRing.material.opacity = (0.3 + 0.16 * Math.sin(t * 3.4)) * (1 - 0.35 * lift) + 0.14 * lift;
    ballRing.scale.setScalar(1 + 0.7 * lift);

    // ---- referee-derived overlays
    const cmds = D.referee ? D.referee.commands : null;
    const ci = cmds ? holdIndex(cmds, t) : -1;
    const cmd = ci >= 0 ? cmds[ci].command : null;
    // Only two commands impose a standoff on the BALL: STOP, and a free kick until the ball is IN
    // PLAY. That moment is the same `computeInPlay` derivation the HUD chip reads (0.05 m of real
    // ball travel or the 5 s ceiling), never a fixed delay. See KEEP_OUT_RING_CMD for the rest.
    const tFreeInPlay = ci >= 0 && cmd && FREE_KICK_CMD.test(cmd) ? inPlay[ci] : null;
    const freeKickSet = tFreeInPlay != null && t < tFreeInPlay;
    keepOut.visible = ((!!cmd && KEEP_OUT_RING_CMD.test(cmd)) || freeKickSet) && ball.visible;
    if (keepOut.visible) {
      keepOut.position.set(bx, Y_RING - 0.0004, -by);
      keepOut.material.opacity = 0.2 + 0.12 * Math.sin(t * 2.6);
    }

    // Held commands carry the last designated point forward, so the command test is what keeps a
    // stale target off the felt once the placement has been signed off.
    const dp = ci >= 0 && cmd && PLACEMENT_CMD.test(cmd) ? cmds[ci].designatedPosition : null;
    placeTarget.visible = !!dp && dp.length === 2;
    if (placeTarget.visible) {
      placeTarget.position.set(dp[0], Y_RING - 0.0002, -dp[1]);
      placeTarget.children[0].material.opacity = 0.4 + 0.2 * Math.sin(t * 2.6);
    }

    // The placement keep-out, posed off the LIVE ball: the placing robot is dribbling the ball to
    // the designated point, so the corridor shortens and swings every frame, and what is drawn is
    // the keep-out as it stands now rather than as it stood at the whistle.
    placeCorridor.visible = placeTarget.visible && ball.visible;
    if (placeCorridor.visible) {
      const ddx = dp[0] - bx;
      const ddy = dp[1] - by;
      const len = Math.hypot(ddx, ddy);
      placeCorridor.position.set(bx, Y_RING - 0.0004, -by);
      // three rotation.y = the SSL heading: local +x maps to SSL (cos, sin) under (x, y) -> (x, -z)
      placeCorridor.rotation.y = len > 1e-6 ? Math.atan2(ddy, ddx) : 0;
      // A corridor of zero length is not half a ring: it is the 0.5 m ring the rule describes,
      // around a ball that has arrived. Only the STRAIGHTS collapse. Hiding the far cap with them
      // left the near half-annulus alone on the felt (the caps are complementary halves) for the
      // ~2.2 s the second placement spends here; co-centring it closes the ring.
      const long = len > PLACE_CORRIDOR_MIN_M;
      placeCorridorBands.visible = long;
      if (long) placeCorridorBands.scale.x = len;
      placeCorridorFarCap.visible = true;
      placeCorridorFarCap.position.x = long ? len : 0;
      placeCorridor.children[0].material.opacity = 0.2 + 0.12 * Math.sin(t * 2.6);
    }

    // ---- highlight pulse (rescue's idiom: the part glows, and here a halo finds it on a 12 m pitch)
    if (hot) {
      halo.position.set(hot.group.position.x, Y_RING + 0.0004, hot.group.position.z);
      const pulse = 0.3 + Math.abs(Math.sin(t * 4.2)) * 0.55;
      halo.material.opacity = pulse * 0.8;
      hot.mats[0].emissiveIntensity = pulse;
      hot.mats[1].emissiveIntensity = pulse;
    }

    // ---- HUD + venue screen, both change-driven
    const st = hudState(t);
    if (st && venue && venueDraw !== st.version) {
      venueDraw = st.version;
      venue.draw(st);
    }
  }

  function sameSegment(a, b) {
    const segs = D.ball.segments;
    if (!segs || !segs.length) return true;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (a >= s.i0 && b < s.i0 + s.n) return true;
    }
    return false;
  }

  /** First `{t, tEnd}` span containing t. Lists here are single-digit, so a scan is the cheap path. */
  function spanAt(list, t) {
    for (let i = 0; i < list.length; i++) {
      if (t >= list[i].t && t <= list[i].tEnd) return list[i];
    }
    return null;
  }
  function absenceAt(rb, t) {
    return rb.absences && rb.absences.length ? spanAt(rb.absences, t) : null;
  }

  /**
   * When the ball came into play after each referee command. ONE derivation, in in-play.js, shared
   * with the telemetry synthesis and the self-tests. A `null` is UNKNOWN - a command the ball
   * cannot be in play under, or a held pre-window restart the stage clock cannot resolve - and
   * every consumer below renders nothing for it rather than inventing a restart at the crop edge.
   */
  function computeInPlay() {
    return inPlayTimes(D.referee, D.ball, D.tBall);
  }

  /**
   * The state a restart shows BEFORE the ball is in play. A free kick keeps its own label; a
   * NORMAL_START carries no team of its own, because it is the second half of a handshake, so it
   * shows the PREPARE_ command that opened the sequence.
   */
  function pendingRestartLabel(ci) {
    const cmds = D.referee.commands;
    const cmd = cmds[ci];
    if (cmd.command === 'NORMAL_START' && ci > 0 && /^PREPARE_/.test(cmds[ci - 1].command)) {
      return commandLabel(cmds[ci - 1].command, D.teams || {});
    }
    return commandLabel(cmd.command, D.teams || {});
  }

  // ------------------------------------------------------------------ HUD contract

  /**
   * The referee state at t, version-keyed so the viewer only touches the DOM on a transition.
   * Every field is sample/held from the exported referee track: the score steps at the moment
   * the human referee awarded the goal (14.4 s after the ball crossed, in this window), and the
   * stage clock is a signed countdown of PLAYING time that freezes during stoppages.
   */
  let hudCi = -2;
  let hudSi = -2;
  let hudTi = -2;
  let hudRunning = null;
  function fillTeam(slot, colour, ts) {
    const info = ts ? ts[colour] : null;
    const team = (D.teams || {})[colour] || {};
    slot.name = team.shortName || team.displayName || colour;
    slot.color = colour; // refereeColor, never the display palette
    slot.score = info ? info.score : 0;
    slot.cards = info ? info.yellowCards : 0;
    slot.reds = info ? info.redCards : 0;
    slot.maxBots = info ? info.maxAllowedBots : null;
    // The keeper id the team registered, which the game controller can move mid-half. `script.js`'s
    // own-goal table names the same robot and `ssl-script.test.mjs` asserts the two agree.
    slot.keeper = info && info.goalkeeper != null ? info.goalkeeper : null;
    // Timeouts REMAINING. The exported TeamInfo has no timeout-seconds field, so the strip shows
    // the count alone; constant on this window (yellow 2, blue 3) but read per sample, not pinned.
    slot.timeouts = info && info.timeouts != null ? info.timeouts : null;
  }
  function hudState(tSec) {
    if (!built || !D.referee) return null;
    const t = Number.isFinite(tSec) ? tSec : 0;
    const ref = D.referee;

    const ci = holdIndex(ref.commands || [], t);
    const si = holdIndex(ref.stageClock || [], t);
    const ti = holdIndex(ref.teamState || [], t);
    // The ball coming into play is a state change WITHIN one command, so it is its own key here.
    const tInPlay = ci >= 0 ? inPlay[ci] : null;
    const running = tInPlay != null && t >= tInPlay;
    if (ci === hudCi && si === hudSi && ti === hudTi && running === hudRunning) return hud;

    if (ci !== hudCi || running !== hudRunning) {
      const cmd = ci >= 0 ? ref.commands[ci] : null;
      if (tInPlay == null) hud.state = commandLabel(cmd && cmd.command, D.teams || {});
      else hud.state = running ? { label: 'RUNNING', tone: 'live' } : pendingRestartLabel(ci);
    }
    if (si !== hudSi) {
      const s = si >= 0 ? ref.stageClock[si] : null;
      hud.clock = s ? clockText(s.leftUs) : '--:--';
      const stage = s ? s.stage : (ref.stages && ref.stages[0] && ref.stages[0].stage) || '';
      hud.stage = stageLabel(stage);
    }
    if (ti !== hudTi) {
      const ts = ti >= 0 ? ref.teamState[ti] : null;
      fillTeam(hud.teams[0], 'yellow', ts);
      fillTeam(hud.teams[1], 'blue', ts);
    }
    hudCi = ci;
    hudSi = si;
    hudTi = ti;
    hudRunning = running;
    // stageClock ticks ~1 Hz and FREEZES during stoppages, so key on the rendered text rather
    // than the sample index: a held clock must not churn the DOM once a second.
    hud.version =
      (ci >= 0 ? ref.commands[ci].counter : -1) +
      '|' + (running ? 'run' : 'set') +
      '|' + hud.clock +
      '|' + hud.stage +
      '|' + hud.teams[0].score + ':' + hud.teams[1].score +
      '|' + hud.teams[0].cards + '/' + hud.teams[0].reds + '/' + hud.teams[0].maxBots +
      '|' + hud.teams[1].cards + '/' + hud.teams[1].reds + '/' + hud.teams[1].maxBots +
      '|' + hud.teams[0].keeper + '/' + hud.teams[0].timeouts +
      '|' + hud.teams[1].keeper + '/' + hud.teams[1].timeouts;
    return hud;
  }

  // ------------------------------------------------------------------ camera + highlight

  /**
   * With an argument: the exported focus track, which is the primary ball track smoothed over
   * 0.5625 s on the ball cadence (`MatchData.focus`), hold-filled across ball absences.
   *
   * Without one, this is the picker card / brief hero asking where the machine IS at the moment it
   * was just posed at, so it answers with the focus point of the last update() rather than with a
   * moment of its own. That matters here more than it does for a robot on a table: the picker poses
   * this scene against the small preview slice, whose clock is its own, and a focus point computed
   * from a different notion of "the hero moment" would frame the shot several metres of ball travel
   * away from the robots that are actually in it.
   */
  function cameraFocus(tSec) {
    if (!built) return null;
    const p = Number.isFinite(tSec) ? sampleFocus(tSec) : lastFocus || heroFocus;
    if (!p) return null;
    focusOut.x = p.x;
    focusOut.y = 0.06;
    focusOut.z = -p.y;
    return focusOut;
  }

  // The exported focus track is already smoothed, so the spring only has to absorb the tracker's
  // jitter and lead the shot into a break. A long lead at 6 m/s throws the camera a metre past the
  // ball, and the default 1.2 m snap fires on every hard pass, so both come down; the snap is left
  // wide enough to still catch a scrub.
  const followTuning = { omega: 3.4, lead: 0.14, snap: 3.0 };

  function applyHighlight() {
    hot = null;
    robots.forEach((r) => {
      const on = r.key === highlight;
      if (on) hot = r;
      r.mats[0].emissive.setHex(on ? 0xff5f57 : 0x000000);
      r.mats[1].emissive.setHex(on ? 0xff5f57 : 0x000000);
      r.mats[0].emissiveIntensity = on ? 0.6 : 0;
      r.mats[1].emissiveIntensity = on ? 0.6 : 0;
    });
    if (halo) {
      halo.visible = !!hot;
      halo.material.opacity = hot ? 0.4 : 0;
    }
  }

  /** `bot_y7`, `bot_b13`: referee colour initial + the tracked id. Shared with data.js. */
  function setHighlight(partId) {
    highlight = partId && /^bot_[yb]\d+$/.test(partId) ? partId : null;
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
    inPlay = [];
    placeTarget = null;
    keepOut = null;
    placeCorridor = null;
    placeCorridorBands = null;
    placeCorridorFarCap = null;
    lastFocus = null;
    hot = null;
    highlight = null;
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
    // The viewer's default rig is wrong for a 12 x 9 m pitch: an 80 m ground plane and two 60 m
    // grids sit under the carpet, and a 1024^2 shadow map over an 18 m frustum is ~18 mm/texel.
    rendering: {
      ground: false,
      grids: false,
      shadow: false,
      anisotropy: true,
      fog: { color: 0x0e1114, near: 20, far: 74 },
    },
  };
}
