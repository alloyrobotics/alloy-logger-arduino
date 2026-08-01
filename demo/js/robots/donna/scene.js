// donna/scene.js - Donna's recorded RoboCup German Open 2025 match, replayed on a KidSize field.
//
// Nothing here is simulated. The joint columns are RECORDED `/joint_states.position` measurements,
// not commands, and the display interpolates between their 25 Hz samples. Torso attitude and field
// position come from recorded tracks. Ball position comes from the filtered recorded estimate, with
// rendered z clamped to the ball radius for ground contact. Torso HEIGHT is derived because the log
// records the robot's joints, attitude and (x, y, yaw) on the field but never how far its hips are off
// the ground. See groundOffset() for exactly how that number is produced and why.
//
// FRAMES. The payload is in the ROS FLU field frame the Bit-Bots localization publishes: x along
// the 9 m touch line, y left, z up, origin at the centre mark, yaw CCW about +z from +x. three.js
// is y-up, so the scene ROOT carries the frozen frame map from CONTRACTS.md (g)
//
//     three.x = -ros.y
//     three.y =  ros.z
//     three.z = -ros.x
//
// and EVERYTHING inside the root - field, goals, lines, ball, rig - is authored in ROS metres.
// The map is a proper rotation (det = +1), so winding and normals survive it untouched. Putting it
// on the root rather than open-coding it at every call site is what makes the frame contract one
// testable object instead of forty conversions.
//
// YAW IS APPLIED EXACTLY ONCE (R1-M3). Heading comes from the segmented localization pose and
// nothing else. The torso quaternion in the payload is the yaw-FREE tilt quaternion the extractor
// froze: it rotates world vertical onto the torso up axis and its z component is identically zero.
// So the robot group carries `rotation.z = poseYaw` and the torso node carries the tilt, and no
// yaw is ever applied a second time. One honest consequence, recorded here rather than hidden:
// the tilt quaternion's lean AXIS was expressed in the IMU's own drifting yaw reference, which the
// extractor discarded with the yaw, so the lean is rendered inside the localization heading. The
// lean ANGLE - the quantity the known-pose fixture binds and the pose test asserts - is exact; the
// lean AZIMUTH is only as good as the two yaw references agreeing.
//
// The scene is built LAZILY, on the first update() that arrives with a decoded payload, because
// donna-data.js is ~650 KB and buildScene() runs on the picker's boot path before any data exists.
// update() is where the data contract lives (`viewer.js` passes `def.getSceneData?.() ?? def.data`),
// so that is where the field gets built - off the 6 s preview slice on the picker card, off the
// full 306 s match on the demo screen, through one code path either way.
//
// NO `document`. Every surface in this file is untextured geometry or a DataTexture, so buildScene()
// runs unchanged inside Node against the vendored three, which is what lets the pose and HUD
// contracts be proven by plain `node` tests instead of by a browser nobody installs.
//
// PER-FRAME ALLOCATION IS ZERO. Every vector, quaternion, matrix and string buffer below is
// allocated once at build time; update() and hudState() only write into them.

// ---------------------------------------------------------------------------- field dimensions
//
// CITED. RoboCup Soccer Humanoid League, "Laws of the Game 2025", April 14th 2025, retrieved
// 2026-07-31 from https://humanoid.robocup.org/wp-content/uploads/RC-HL-2025-Rules.pdf
//
//   Law 1, Table 1 "Approximate dimensions of the rectangular field of soccer play", KidSize column:
//     A Field length              9 m
//     B Field width               6 m
//     C Goal depth                0.6 m
//     D Goal width                2.6 m
//       Goal height               1.2 m
//     E Goal area length          1 m
//     F Goal area width           3 m
//     G Penalty mark distance     1.5 m
//     H Centre circle diameter    1.5 m
//     I Border strip width (min.) 1 m
//     J Penalty area length       2 m
//     K Penalty area width        5 m
//   Law 1, "Field markings": "All lines must be of the same width, which must be approximately
//     5 cm", and the centre circle is "a circle with a radius of 0.75 m for KidSize".
//   Law 1, "Goals": "The distance between the posts is 2.6 m and the distance from the lower edge
//     of the crossbar to the ground is 1.2 m for KidSize"; "Both goalposts and the crossbar have
//     the same width and depth, which is not smaller than 8 cm and do not exceed 12 cm".
//   Law 1, "Field surface": "Matches may be played on artificial surfaces"; "The colour of
//     artificial surfaces must be green".
//   Law 2, "Qualities and measurements": the ball is "FIFA size 1 for KidSize". FIFA size 1 is a
//     41-43 cm circumference, so BALL_R below is that size expressed as a radius; it is the one
//     field number derived rather than quoted, and the rules give no metre figure for it.
//
// The goal-area and penalty-area widths in the table are consistent with the offsets in the prose
// (2.6 + 2 x 0.2 = 3 m, 2.6 + 2 x 1.2 = 5 m), so the two are not independent numbers and the
// prose offsets are what the geometry below is built from.
const FIELD = {
  lengthM: 9.0,
  widthM: 6.0,
  lineM: 0.05,
  borderM: 1.0,
  centreCircleRM: 0.75,
  penaltyMarkM: 1.5,
  goalWidthM: 2.6,
  goalHeightM: 1.2,
  goalDepthM: 0.6,
  goalPostM: 0.1, // inside the rules' 0.08-0.12 m window
  goalAreaDepthM: 1.0,
  goalAreaOffsetM: 0.2, // from the inside of each post
  penaltyAreaDepthM: 2.0,
  penaltyAreaOffsetM: 1.2, // from the inside of each post
};
const BALL_R = 0.0684; // FIFA size 1, 43 cm circumference / 2 pi

const HALF_L = FIELD.lengthM / 2;
const HALF_W = FIELD.widthM / 2;

// Decal stacking on the pitch, millimetres apart so a mark never z-fights the line under it.
const Z_TURF = 0.0;
const Z_LINE = 0.0016;
const Z_MARK = 0.0026;
const Z_CONTACT = 0.0034;
const Z_HALO = 0.0042;

// ---------------------------------------------------------------------------- rig
//
// FROZEN. The 20 revolute joints of the Wolfgang-OP, transcribed from `rig/RIG.json`, which the
// Phase 0 extractor pulled out of the MIT-licensed `bit-bots/wolfgang_robot` URDF (c) Hamburg
// Bit-Bots. Names match `/joint_states.name` exactly and in the payload's own column order.
//
// Each row is [name, parent link, child link, origin xyz, origin rpy, axis]. `rpy` is the URDF
// convention R = Rz(yaw) Ry(pitch) Rx(roll), which is three's Euler order 'ZYX'. Exporter float
// noise below 1e-6 rad/m (terms like 1.66533e-15) is written as an exact zero; every digit that
// carries meaning is verbatim, including the ones that are NOT mirror-symmetric between the left
// and right sides - LKnee's 2.87979 rad origin yaw, RKnee's -0.261799 rad origin pitch and
// RAnkleRoll's 1.54833 rad origin pitch are all really in the URDF, and a "tidied" symmetric rig
// would bend this robot's legs differently from the machine that recorded the log.
//
// `limit` is carried for reference only and is NEVER used to clamp: the hardware interface's own
// limit config differs from the URDF's (CONTRACTS.md (g)), and a replay that silently clamped a
// recorded angle would be showing a pose the robot did not hold.
const RIG = [
  ['HeadPan', 'torso', 'neck', [-0.0095, 0, 0.2345], [-3.14159, 0, 0], [0, 0, -1], [-2.3562, 2.3562]],
  ['HeadTilt', 'neck', 'head', [0.036, 0.0235, -0.024], [-1.5708, 0, 0], [0, 0, 1], [-1.5708, 1.0472]],

  ['LShoulderPitch', 'torso', 'l_shoulder', [-0.0015, 0.0765, 0.2035], [-3.14159, 0, 3.14159], [0, 1, 0], [-3.1416, 3.1416]],
  ['LShoulderRoll', 'l_shoulder', 'l_upper_arm', [-0.01695, 0.042, 0], [-1.5708, 0, 1.5708], [0, 0, -1], [-3.1416, 0]],
  ['LElbow', 'l_upper_arm', 'l_lower_arm', [-0.024, -0.144, -0.0235], [-1.5708, 0, 1.5708], [0, 0, 1], [-1.5708, 1.0472]],

  ['RShoulderPitch', 'torso', 'r_shoulder', [-0.0015, -0.0765, 0.2035], [0, 0, -3.14159], [0, 1, 0], [-3.1416, 3.1416]],
  ['RShoulderRoll', 'r_shoulder', 'r_upper_arm', [-0.01695, 0.042, 0], [1.5708, 0, -1.5708], [0, 0, -1], [0, 3.1416]],
  ['RElbow', 'r_upper_arm', 'r_lower_arm', [0.024, -0.144, -0.0235], [-1.5708, 0, -1.5708], [0, 0, 1], [-1.0472, 1.5708]],

  ['LHipYaw', 'torso', 'l_hip_1', [0, 0.055, 0], [-1.5708, 0, 0], [0, 1, 0], [-1.5708, 1.5708]],
  ['LHipRoll', 'l_hip_1', 'l_hip_2', [-0.046, 0.0414, 0], [3.14159, 1.5708, 0], [0, 0, -1], [-1.5708, 1.5708]],
  ['LHipPitch', 'l_hip_2', 'l_upper_leg', [0.026, 0, -0.0691], [0, -1.5708, 0], [0, 0, -1], [-1.9199, 2.0944]],
  ['LKnee', 'l_upper_leg', 'l_lower_leg', [0.00435596, -0.168793, 0.049], [1.5708, 0, 2.87979], [0, 1, 0], [0, 2.9671]],
  ['LAnklePitch', 'l_lower_leg', 'l_ankle', [0, -0.0505, -0.17], [-1.5708, 0, 3.14159], [0, 0, -1], [-1.2217, 1.7453]],
  ['LAnkleRoll', 'l_ankle', 'l_foot', [0.0691, 0, -0.026], [1.5708, -1.5708, 0], [0, -1, 0], [-1.0472, 1.0472]],

  ['RHipYaw', 'torso', 'r_hip_1', [0, -0.055, 0], [-1.5708, 0, 0], [0, 1, 0], [-1.5708, 1.5708]],
  ['RHipRoll', 'r_hip_1', 'r_hip_2', [-0.046, 0.0414, 0], [-3.14159, 1.5708, 0], [0, 0, -1], [-1.5708, 1.5708]],
  ['RHipPitch', 'r_hip_2', 'r_upper_leg', [-0.0265, 0, -0.0691], [-1.5708, 1.5708, 0], [0, 1, 0], [-2.0944, 1.9199]],
  ['RKnee', 'r_upper_leg', 'r_lower_leg', [-0.00392295, -0.051, -0.169043], [0, -0.261799, 0], [0, -1, 0], [-2.9671, 0]],
  ['RAnklePitch', 'r_lower_leg', 'r_ankle', [0, 0.0505, -0.17], [-1.5708, 0, 0], [0, 0, -1], [-1.7453, 1.2217]],
  ['RAnkleRoll', 'r_ankle', 'r_foot', [-0.0691, 0, -0.026], [0, 1.54833, -1.5708], [0, -1, 0], [-1.0472, 1.0472]],
];

// ---------------------------------------------------------------------------- palette
//
// House 3D style, same construction as the other two replay scenes: matte dark shell, one accent,
// emissive used only where a real machine emits. The accent is the alloy blue the picker card
// carries. The two HUD dot colours are the strip's own two-team affordance and NOT a recorded team
// marking - this log exports no team colour for either side, which is also why the second team is
// called "Opponent" rather than named.
const SHELL = 0x2b2f34;
const SHELL_DARK = 0x1a1c20;
const ACCENT = 0x2f78ff;
const FOOT = 0x141619;
const TURF = 0x22402b;
const TURF_BORDER = 0x1a3222;
const LINE = 0xeef1f3;
const GOAL_FRAME = 0xe8ecef;
const NET = 0x94a6b8;
const BALL_LIGHT = 0xe9ecee;
const BALL_DARK = 0x22262b;
const ALERT = 0xff5f57;

// ---------------------------------------------------------------------------- camera
//
// The shot is framed for the follow spring, not for a static wide: the viewer translates camera
// and target together, so this OFFSET is the follow framing and "reset view" recentres it on
// whatever the robot is doing. |offset| = 3.4 m at 23 deg elevation, swung 28 deg off the field's
// long axis - near enough to end-on that a goal stays behind the play, far enough off it that the
// pitch reads as a plane. The subject here is ONE 0.8 m machine rather than a fleet, so the offset
// is half what the other two replay scenes use: at this distance Donna is about a third of the
// frame's height, the ball at her feet is a ball rather than a pixel, and roughly 5 m of pitch
// still sits around her. Expressed in THREE coordinates, because the viewer applies it to its own
// camera and never sees the ROS frame.
export const cameraHome = {
  position: { x: 1.47, y: 1.68, z: 2.76 },
  target: { x: 0, y: 0.35, z: 0 },
};

// The frozen healthy-hero moment: WALKING window, upright, ball visible, 2-0 buildup (CONTRACTS (h)).
const HERO_T = 240.3;

// ---------------------------------------------------------------------------- event ids
//
// The scene reads exactly four rows out of the frozen 20-row ledger, by id, and derives the game
// state machine from them. It reads them by ID and not by index so a re-ordered ledger fails loudly
// instead of rendering the wrong instant.
const EV_PENALTY = 'penalty-reentry';
const EV_GOAL = 'goal-2-0';
const EV_BLIP = 'ready-set-blip';
const EV_WHISTLE = 'final-whistle';
const GOAL_NOTE_S = 3.0; // how long the goal callout stands on the strip after its recorded instant

// ---------------------------------------------------------------------------- small helpers

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest-arc interpolation between two wrapped radian headings. */
function lerpRad(a, b, s) {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * s;
}

/**
 * m:ss from the recorded `secondsRemaining`.
 *
 * The RoboCup game controller counts a half DOWN and then keeps going, so this match's clock is
 * negative for its last 76 s while secondary_state remains STATE_NORMAL. Negative renders as added
 * time with a leading "+", which is what the referee display shows and what the copy quotes
 * ("+0:49" at the goal).
 */
function clockText(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const neg = sec < 0;
  const s = Math.abs(Math.round(sec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${neg ? '+' : ''}${mm}:${ss < 10 ? '0' : ''}${ss}`;
}

// ---------------------------------------------------------------------------- geometry batcher

/**
 * Accumulates untextured triangles so the pitch, the goals and each rig link land in a handful of
 * draw calls. All coordinates are ROS FLU metres; the root's frame map does the rest.
 *
 * Normals are COMPUTED from the winding rather than passed in. One code path, and a face that was
 * wound the wrong way would render as a hole rather than as a lie about which way it faces.
 */
function Batch() {
  this.p = [];
  this.n = [];
}
Batch.prototype.tri = function tri(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
};
Batch.prototype.quad = function quad(a, b, c, d) {
  this.tri(a, b, c);
  this.tri(a, c, d);
};
/** Axis-aligned box, centre + size, ROS metres. Wound outward on all six faces. */
Batch.prototype.box = function box(cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  this.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  this.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
};
/**
 * An oriented box from A to B with a `w` x `h` cross-section: the link shell the rig is drawn with.
 * Its own frame is built off the segment direction, so a limb whose child joint sits off-axis (and
 * on this robot several do) gets a shell that actually spans the two joint origins.
 */
Batch.prototype.bone = function bone(ax, ay, az, bx, by, bz, w, h) {
  let dx = bx - ax;
  let dy = by - ay;
  let dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-6)) return;
  dx /= len;
  dy /= len;
  dz /= len;
  // any up that is not parallel to the bone; the shell is a box, so its roll about its own axis
  // is a styling choice and not a rig quantity
  const upx = Math.abs(dz) > 0.9 ? 1 : 0;
  const upz = Math.abs(dz) > 0.9 ? 0 : 1;
  let rx = dy * upz - dz * 0;
  let ry = dz * upx - dx * upz;
  let rz = dx * 0 - dy * upx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = ry * dz - rz * dy;
  const uy = rz * dx - rx * dz;
  const uz = rx * dy - ry * dx;
  const c = (s, u, v) => [
    ax + dx * s * len + rx * (u * w) / 2 + ux * (v * h) / 2,
    ay + dy * s * len + ry * (u * w) / 2 + uy * (v * h) / 2,
    az + dz * s * len + rz * (u * w) / 2 + uz * (v * h) / 2,
  ];
  this.quad(c(0, 1, -1), c(1, 1, -1), c(1, 1, 1), c(0, 1, 1));
  this.quad(c(0, -1, 1), c(1, -1, 1), c(1, -1, -1), c(0, -1, -1));
  this.quad(c(0, 1, 1), c(1, 1, 1), c(1, -1, 1), c(0, -1, 1));
  this.quad(c(0, 1, -1), c(0, -1, -1), c(1, -1, -1), c(1, 1, -1));
  this.quad(c(1, 1, -1), c(1, -1, -1), c(1, -1, 1), c(1, 1, 1));
  this.quad(c(0, 1, -1), c(0, 1, 1), c(0, -1, 1), c(0, -1, -1));
};
/** A flat rectangle on the pitch, ROS metres. */
Batch.prototype.rect = function rect(x0, y0, x1, y1, z) {
  this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
};
/** A flat stripe between two pitch points, `w` wide, squared off at both ends. */
Batch.prototype.stripe = function stripe(ax, ay, bx, by, w, z) {
  let dx = bx - ax;
  let dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const px = (-dy * w) / 2;
  const py = (dx * w) / 2;
  this.quad(
    [ax - px, ay - py, z],
    [bx - px, by - py, z],
    [bx + px, by + py, z],
    [ax + px, ay + py, z]
  );
};
/** Rectangular outline on the pitch, drawn on the CENTRE of the line as the rules mark it. */
Batch.prototype.outline = function outline(x0, y0, x1, y1, w, z) {
  this.stripe(x0, y0, x1, y0, w, z);
  this.stripe(x1, y0, x1, y1, w, z);
  this.stripe(x1, y1, x0, y1, w, z);
  this.stripe(x0, y1, x0, y0, w, z);
};
/** A ring band on the pitch: the centre circle. */
Batch.prototype.annulus = function annulus(cx, cy, r0, r1, seg, z) {
  for (let i = 0; i < seg; i++) {
    const a0 = (Math.PI * 2 * i) / seg;
    const a1 = (Math.PI * 2 * (i + 1)) / seg;
    this.quad(
      [cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0), z],
      [cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0), z],
      [cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1), z],
      [cx + r0 * Math.cos(a1), cy + r0 * Math.sin(a1), z]
    );
  }
};
/** A filled disc on the pitch: the centre mark and the two penalty marks. */
Batch.prototype.disc = function disc(cx, cy, r, seg, z) {
  for (let i = 0; i < seg; i++) {
    const a0 = (Math.PI * 2 * i) / seg;
    const a1 = (Math.PI * 2 * (i + 1)) / seg;
    this.tri(
      [cx, cy, z],
      [cx + r * Math.cos(a0), cy + r * Math.sin(a0), z],
      [cx + r * Math.cos(a1), cy + r * Math.sin(a1), z]
    );
  }
};
Batch.prototype.build = function build(THREE) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
  return g;
};

/**
 * A soft round contact patch as a DataTexture.
 *
 * The other two replay scenes paint theirs into a canvas, which needs `document`; this one is
 * generated as raw bytes so the whole scene stays constructible in Node and the pose and HUD
 * contracts can be proven without a browser.
 */
function contactTexture(THREE) {
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(i - (N - 1) / 2, j - (N - 1) / 2) / (N / 2);
      const a = d >= 1 ? 0 : Math.round(255 * (1 - d) ** 1.6);
      const k = (j * N + i) * 4;
      // three reads an alphaMap from the GREEN channel, not from the alpha channel. Writing the
      // falloff into RGB and leaving alpha opaque is what makes this a soft disc instead of the
      // hard black square a texture that only carried it in alpha renders as.
      data[k] = a;
      data[k + 1] = a;
      data[k + 2] = a;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------- buildScene

/**
 * @param {import('three')} THREE
 * @param {import('three').Group} mount scene-graph container owned by viewer.js
 */
export function buildScene(THREE, mount) {
  const root = new THREE.Group();
  root.name = 'donna-root';
  // The frozen ROS FLU -> three.js map, as one rotation on one node. Columns are the images of the
  // ROS basis vectors: ros.x -> (0, 0, -1), ros.y -> (-1, 0, 0), ros.z -> (0, 1, 0).
  root.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().set(
      0, -1, 0, 0,
      0, 0, 1, 0,
      -1, 0, 0, 0,
      0, 0, 0, 1
    )
  );
  mount.add(root);

  const disposables = [];
  const keep = (o) => {
    disposables.push(o);
    return o;
  };

  let D = null; // decoded payload, once update() hands it over
  let built = false;
  let links = null; // link name -> { node, vis }
  let joints = null; // rig rows resolved to nodes + precomputed fixed rotations
  let robot = null; // the group carrying field pose + heading
  let torso = null; // the link node carrying the tilt quaternion
  let ball = null;
  let contact = null;
  let halo = null;
  let shellMats = [];
  let accentMats = [];
  let contactPts = []; // { node, x, y, z } in each link's own frame
  let evPenaltyT = 0;
  let evGoal = null;
  let evBlip = null;
  let evWhistleT = Infinity;
  let highlight = null;
  let lastFocus = null;
  let heroFocus = null;
  // The follow spring asks cameraFocus() for the SAME instant update() was just handed, so the
  // posed moment is cached: without it every frame poses the whole rig twice.
  let lastPoseT = null;

  const vTmp = new THREE.Vector3();
  const qTmp = new THREE.Quaternion();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const focusOut = { x: 0, y: 0.3, z: 0 };
  const heroOut = { x: 0, y: 0.3, z: 0 };

  // Allocated ONCE and mutated in place, exactly like battle's: the strip renders off `version`,
  // and a producer that reallocated would churn a fresh object sixty times a second for a string
  // that changes a handful of times a minute.
  //
  // Note which keys are ABSENT. RoboCup Humanoid League has no yellow/red card state, no timeout
  // count and no max-bots limit on this wire, and the log exports no goalkeeper id and no half
  // indicator, so `cards`, `reds`, `timeouts`, `maxBots`, `keeper` and `stage` are not on these
  // objects at all. viewer.js renders nothing for a field a team does not define, and sending any
  // of them as a zero would put a truthful-looking "0Y" on the strip for a league with no cards.
  const hud = {
    version: '',
    clock: '--:--',
    state: { label: 'PLAYING', tone: 'live', note: '' },
    teams: [
      { name: 'Bit-Bots', color: 'blue', score: 0 },
      { name: 'Opponent', color: 'red', score: 0 },
    ],
  };

  // ------------------------------------------------------------------ the field

  function buildField() {
    const bx = HALF_L + FIELD.borderM;
    const by = HALF_W + FIELD.borderM;

    // ---- border strip and field of play. Two surfaces rather than one, so the 1 m border reads
    // as the run-off it is instead of the pitch looking 11 x 8 m.
    const border = new Batch();
    border.rect(-bx, -by, bx, by, Z_TURF - 0.001);
    const borderMat = keep(
      new THREE.MeshStandardMaterial({ color: TURF_BORDER, roughness: 1.0, metalness: 0.0 })
    );
    const borderMesh = new THREE.Mesh(keep(border.build(THREE)), borderMat);
    borderMesh.name = 'border-strip';
    root.add(borderMesh);

    const turf = new Batch();
    turf.rect(-HALF_L, -HALF_W, HALF_L, HALF_W, Z_TURF);
    const turfMat = keep(new THREE.MeshStandardMaterial({ color: TURF, roughness: 1.0, metalness: 0.0 }));
    const turfMesh = new THREE.Mesh(keep(turf.build(THREE)), turfMat);
    turfMesh.name = 'pitch';
    root.add(turfMesh);

    // ---- markings, every one of them off the cited table
    const w = FIELD.lineM;
    const lines = new Batch();
    lines.outline(-HALF_L, -HALF_W, HALF_L, HALF_W, w, Z_LINE); // touch + goal lines
    lines.stripe(0, -HALF_W, 0, HALF_W, w, Z_LINE); // halfway line
    lines.annulus(0, 0, FIELD.centreCircleRM - w / 2, FIELD.centreCircleRM + w / 2, 72, Z_LINE);
    [-1, 1].forEach((side) => {
      const goalLine = side * HALF_L;
      const gaY = FIELD.goalWidthM / 2 + FIELD.goalAreaOffsetM;
      const gaX = goalLine - side * FIELD.goalAreaDepthM;
      lines.stripe(goalLine, gaY, gaX, gaY, w, Z_LINE);
      lines.stripe(gaX, gaY, gaX, -gaY, w, Z_LINE);
      lines.stripe(gaX, -gaY, goalLine, -gaY, w, Z_LINE);
      const paY = FIELD.goalWidthM / 2 + FIELD.penaltyAreaOffsetM;
      const paX = goalLine - side * FIELD.penaltyAreaDepthM;
      lines.stripe(goalLine, paY, paX, paY, w, Z_LINE);
      lines.stripe(paX, paY, paX, -paY, w, Z_LINE);
      lines.stripe(paX, -paY, goalLine, -paY, w, Z_LINE);
    });
    const marks = new Batch();
    marks.disc(0, 0, 0.05, 20, Z_MARK); // centre mark
    [-1, 1].forEach((side) => {
      marks.disc(side * (HALF_L - FIELD.penaltyMarkM), 0, 0.05, 20, Z_MARK);
    });
    const lineMat = keep(new THREE.MeshStandardMaterial({ color: LINE, roughness: 0.9, metalness: 0.0 }));
    const lineMesh = new THREE.Mesh(keep(lines.build(THREE)), lineMat);
    lineMesh.name = 'field-lines';
    root.add(lineMesh);
    const markMesh = new THREE.Mesh(keep(marks.build(THREE)), lineMat);
    markMesh.name = 'field-marks';
    root.add(markMesh);

    // ---- goals. Posts sit immediately behind the goal line so their INSIDE faces are the 2.6 m
    // the rules measure between, and the frame carries on 0.6 m outward to the back uprights.
    const post = FIELD.goalPostM;
    const gh = FIELD.goalHeightM;
    const inner = FIELD.goalWidthM / 2;
    const frame = new Batch();
    const net = new Batch();
    [-1, 1].forEach((side) => {
      const x0 = side * (HALF_L + post / 2);
      const xBack = side * (HALF_L + FIELD.goalDepthM);
      [-1, 1].forEach((s2) => {
        const y = s2 * (inner + post / 2);
        frame.box(x0, y, gh / 2, post, post, gh); // goalpost
        frame.box(xBack, y, gh / 2, post * 0.6, post * 0.6, gh); // back upright
        frame.box((x0 + xBack) / 2, y, gh, Math.abs(xBack - x0), post * 0.6, post * 0.6); // side top rail
        net.rect(x0, y, xBack, y, gh - 0.002); // side panel, drawn flat and lit from both sides
      });
      frame.box(x0, 0, gh + post / 2, post, 2 * inner + 2 * post, post); // crossbar
      frame.box(xBack, 0, gh, post * 0.6, 2 * inner + post, post * 0.6); // back top rail
      // back panel of the net, as an upright quad spanning the mouth width
      net.quad(
        [xBack, -inner, 0.002],
        [xBack, inner, 0.002],
        [xBack, inner, gh],
        [xBack, -inner, gh]
      );
    });
    const frameMat = keep(
      new THREE.MeshStandardMaterial({
        color: GOAL_FRAME,
        roughness: 0.62,
        metalness: 0.05,
        emissive: GOAL_FRAME,
        emissiveIntensity: 0.1,
      })
    );
    const frameMesh = new THREE.Mesh(keep(frame.build(THREE)), frameMat);
    frameMesh.name = 'goals';
    root.add(frameMesh);
    // Rules: nets must be neither green nor white. A translucent slate reads as netting at this
    // scale without a texture and without pretending to be a mesh weave.
    const netMat = keep(
      new THREE.MeshStandardMaterial({
        color: NET,
        roughness: 0.9,
        metalness: 0.0,
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const netMesh = new THREE.Mesh(keep(net.build(THREE)), netMat);
    netMesh.name = 'goal-nets';
    netMesh.renderOrder = 2;
    root.add(netMesh);
  }

  // ------------------------------------------------------------------ the rig

  /**
   * Build the kinematic tree, then hang the shell off it.
   *
   * Every link gets TWO nodes: the joint node, whose transform is exactly the URDF's fixed origin
   * composed with the rotation about the joint axis, and a `vis` child whose rotation is the
   * INVERSE of that link's zero-pose rotation relative to the torso. The vis frame is therefore
   * torso-aligned at the zero pose, which means every shell dimension below can be authored in
   * plain ROS body axes (x forward, y left, z up) with no per-link frame algebra, while the
   * kinematics stay bit-for-bit the URDF's. Get the rig wrong and the pose test fails; get the
   * shell wrong and it only looks wrong.
   */
  function buildRig() {
    links = {};
    joints = [];
    const torsoNode = new THREE.Group();
    torsoNode.name = 'donna:torso';
    links.torso = { node: torsoNode, vis: null };

    for (const [name, parent, child, xyz, rpy, axis] of RIG) {
      const p = links[parent];
      const node = new THREE.Group();
      node.name = `donna:${child}`;
      node.position.set(xyz[0], xyz[1], xyz[2]);
      // URDF rpy is R = Rz(yaw) Ry(pitch) Rx(roll), which is three's Euler order 'ZYX'
      const qFixed = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX')
      );
      node.quaternion.copy(qFixed);
      p.node.add(node);
      links[child] = { node, vis: null };
      joints.push({
        name,
        node,
        qFixed,
        axis: new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(),
        q: 0,
      });
    }

    // Zero pose, then freeze each link's torso-relative rotation so the vis frames can undo it.
    torsoNode.updateMatrixWorld(true);
    const zeroQ = {};
    const zeroP = {};
    for (const name of Object.keys(links)) {
      const n = links[name].node;
      zeroQ[name] = n.getWorldQuaternion(new THREE.Quaternion());
      zeroP[name] = n.getWorldPosition(new THREE.Vector3());
    }
    for (const name of Object.keys(links)) {
      const vis = new THREE.Group();
      vis.name = `donna:${name}:vis`;
      vis.quaternion.copy(zeroQ[name]).invert();
      links[name].node.add(vis);
      links[name].vis = vis;
    }

    // Child joint origins, expressed in each parent's (torso-aligned) vis frame. Because the vis
    // frame is torso-aligned at the zero pose, that is just the difference of zero-pose positions.
    const childOffsets = {};
    for (const [, parent, child] of RIG) {
      (childOffsets[parent] || (childOffsets[parent] = [])).push({
        child,
        d: [
          zeroP[child].x - zeroP[parent].x,
          zeroP[child].y - zeroP[parent].y,
          zeroP[child].z - zeroP[parent].z,
        ],
      });
    }

    buildShell(childOffsets);
    return torsoNode;
  }

  /** Cross-section of the shell drawn between a link and each of its child joints. */
  const BONE_W = {
    l_upper_arm: [0.05, 0.05],
    r_upper_arm: [0.05, 0.05],
    l_upper_leg: [0.075, 0.075],
    r_upper_leg: [0.075, 0.075],
    l_lower_leg: [0.065, 0.065],
    r_lower_leg: [0.065, 0.065],
    l_shoulder: [0.055, 0.055],
    r_shoulder: [0.055, 0.055],
    l_hip_1: [0.06, 0.06],
    r_hip_1: [0.06, 0.06],
    l_hip_2: [0.07, 0.07],
    r_hip_2: [0.07, 0.07],
    l_ankle: [0.06, 0.055],
    r_ankle: [0.06, 0.055],
    neck: [0.045, 0.045],
  };

  function addMesh(linkName, batch, mat, name) {
    if (!batch.p.length) return null;
    const mesh = new THREE.Mesh(keep(batch.build(THREE)), mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    links[linkName].vis.add(mesh);
    return mesh;
  }

  /**
   * The simplified Wolfgang-OP body: torso, head with its camera block, two arms, two legs, all of
   * it boxes and bones authored in body axes. Deliberately NOT the URDF's meshes - this is the
   * house line-art-adjacent 3D style the other two replay scenes use, at the rig's real dimensions.
   */
  function buildShell(childOffsets) {
    const shellMat = keep(
      new THREE.MeshStandardMaterial({ color: SHELL, roughness: 0.68, metalness: 0.22, emissive: 0x000000 })
    );
    const darkMat = keep(
      new THREE.MeshStandardMaterial({ color: SHELL_DARK, roughness: 0.78, metalness: 0.15, emissive: 0x000000 })
    );
    const footMat = keep(
      new THREE.MeshStandardMaterial({ color: FOOT, roughness: 0.92, metalness: 0.05, emissive: 0x000000 })
    );
    const accentMat = keep(
      new THREE.MeshStandardMaterial({
        color: ACCENT,
        roughness: 0.45,
        metalness: 0.2,
        emissive: ACCENT,
        emissiveIntensity: 0.35,
      })
    );
    const lensMat = keep(
      new THREE.MeshStandardMaterial({
        color: 0x0a0c0f,
        roughness: 0.22,
        metalness: 0.5,
        emissive: 0x9fd0ff,
        emissiveIntensity: 0.5,
      })
    );
    shellMats = [shellMat, darkMat, footMat];
    accentMats = [accentMat];

    // ---- bones, one batch per link
    for (const linkName of Object.keys(childOffsets)) {
      if (linkName === 'torso') continue; // the torso is a shell, not a set of bones
      const [w, h] = BONE_W[linkName] || [0.05, 0.05];
      const b = new Batch();
      for (const { d } of childOffsets[linkName]) b.bone(0, 0, 0, d[0], d[1], d[2], w, h);
      addMesh(linkName, b, darkMat, `donna:${linkName}:shell`);
    }

    // ---- torso: one shell from just under the hip line to just over the shoulder line, plus an
    // accent chest plate and the two shoulder blocks the arms hang off.
    const t = new Batch();
    t.box(-0.005, 0, 0.1, 0.115, 0.15, 0.235);
    t.box(-0.02, 0, 0.213, 0.09, 0.175, 0.05); // shoulder yoke
    t.box(0, 0, -0.008, 0.1, 0.135, 0.05); // pelvis
    addMesh('torso', t, shellMat, 'donna:torso:shell');
    const ta = new Batch();
    ta.box(0.056, 0, 0.115, 0.012, 0.085, 0.075); // chest plate
    ta.box(-0.062, 0, 0.1, 0.012, 0.06, 0.13); // back pack face
    addMesh('torso', ta, accentMat, 'donna:torso:accent');

    // ---- head: a box with the forward-looking camera block and its lens, plus a thin accent
    // visor band. The real machine's camera is what every ball estimate in this log came out of,
    // so it is modelled rather than implied.
    const h = new Batch();
    h.box(0.005, 0, 0.028, 0.095, 0.105, 0.085);
    addMesh('head', h, shellMat, 'donna:head:shell');
    const hc = new Batch();
    hc.box(0.056, 0, 0.03, 0.03, 0.06, 0.038); // camera block
    addMesh('head', hc, darkMat, 'donna:head:camera');
    const hl = new Batch();
    hl.box(0.073, 0, 0.03, 0.006, 0.026, 0.026); // lens
    addMesh('head', hl, lensMat, 'donna:head:lens');
    const ha = new Batch();
    ha.box(0.004, 0, 0.062, 0.09, 0.108, 0.008); // visor band
    addMesh('head', ha, accentMat, 'donna:head:accent');

    // ---- forearms, drawn on from the elbow. Terminal links, so there is no child origin to span.
    for (const side of ['l', 'r']) {
      const f = new Batch();
      f.bone(0, 0, 0, 0, 0, -0.115, 0.042, 0.042);
      f.box(0, 0, -0.135, 0.05, 0.05, 0.045); // hand block
      addMesh(`${side}_lower_arm`, f, darkMat, `donna:${side}_lower_arm:shell`);
    }

    // ---- feet. Sole plates sized to a KidSize foot, hung under the ankle roll axis.
    for (const side of ['l', 'r']) {
      const f = new Batch();
      f.box(0.018, 0, -0.021, 0.135, 0.088, 0.026); // sole
      f.box(0, 0, -0.004, 0.06, 0.06, 0.02); // ankle block
      addMesh(`${side}_foot`, f, footMat, `donna:${side}_foot:shell`);
    }

    // ---- contact candidates for the ground solve. Foot sole corners first, because in every
    // upright frame they are the answer; the rest are what keeps a fallen robot ON the pitch
    // instead of hovering over it by the length of its own legs.
    contactPts = [];
    const addPt = (linkName, x, y, z) => {
      contactPts.push({ node: links[linkName].vis, x, y, z });
    };
    for (const side of ['l', 'r']) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          addPt(`${side}_foot`, 0.018 + sx * 0.0675, sy * 0.044, -0.034);
        }
      }
      addPt(`${side}_lower_arm`, 0, 0, -0.155);
      addPt(`${side}_lower_leg`, 0.04, 0, -0.02); // knee front
      addPt(`${side}_upper_arm`, 0, 0, 0);
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          addPt('torso', -0.005 + sx * 0.0575, sy * 0.075, 0.1 + sz * 0.1175);
        }
      }
    }
    addPt('head', 0.005, 0, 0.028);
    addPt('head', 0.073, 0, 0.03);
  }

  function buildBall() {
    const g = keep(new THREE.SphereGeometry(BALL_R, 22, 16));
    const m = keep(
      new THREE.MeshStandardMaterial({ color: BALL_LIGHT, roughness: 0.62, metalness: 0.0 })
    );
    const b = new THREE.Mesh(g, m);
    b.name = 'donna:ball';
    b.castShadow = false;
    // A single dark band, so the ball is not a featureless dot at follow-cam distance. The log
    // records a position, never an orientation, so the band never spins: it is a marking, not a
    // claim about roll.
    const bandGeo = keep(new THREE.TorusGeometry(BALL_R * 0.995, BALL_R * 0.16, 8, 28));
    const bandMat = keep(new THREE.MeshStandardMaterial({ color: BALL_DARK, roughness: 0.7 }));
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.castShadow = false;
    b.add(band);
    root.add(b);
    return b;
  }

  function buildGroundDecals() {
    const tex = keep(contactTexture(THREE));
    const cg = keep(new THREE.PlaneGeometry(0.44, 0.44));
    const cm = keep(
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: tex,
        transparent: true,
        opacity: 0.46,
        depthWrite: false,
      })
    );
    contact = new THREE.Mesh(cg, cm);
    contact.name = 'donna:contact';
    contact.position.z = Z_CONTACT;
    contact.renderOrder = 1;
    root.add(contact);

    const hg = keep(new THREE.RingGeometry(0.26, 0.34, 48));
    const hm = keep(
      new THREE.MeshBasicMaterial({
        color: ALERT,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    halo = new THREE.Mesh(hg, hm);
    halo.name = 'donna:halo';
    halo.position.z = Z_HALO;
    halo.renderOrder = 3;
    halo.visible = false;
    root.add(halo);
  }

  // ------------------------------------------------------------------ lazy build

  function build(data) {
    D = data;
    const ev = {};
    for (const row of data.events || []) ev[row.id] = row;
    evPenaltyT = ev[EV_PENALTY] ? ev[EV_PENALTY].t : 0;
    evGoal = ev[EV_GOAL] || null;
    evBlip = ev[EV_BLIP] || null;
    evWhistleT = ev[EV_WHISTLE] ? ev[EV_WHISTLE].t : Infinity;

    buildField();
    robot = new THREE.Group();
    robot.name = 'donna:robot';
    root.add(robot);
    torso = buildRig();
    robot.add(torso);
    ball = buildBall();
    buildGroundDecals();

    built = true;
    root.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    // Pose once at the frozen hero moment so cameraFocus() has an answer before the first update,
    // which is what the picker card asks for when it stages this robot.
    pose(clampT(HERO_T));
    heroFocus = readFocus(heroOut);
    if (highlight) applyHighlight();
  }

  const clampT = (t) => {
    const w = (D && D.meta && D.meta.window) || [0, 306];
    return t < w[0] ? w[0] : t > w[1] ? w[1] : t;
  };

  // ------------------------------------------------------------------ sampling

  /** Fractional index into a uniform track, clamped to its ends. */
  function uniformIndex(spec, t) {
    const x = (t * 1000 - spec.timing.startMs) / spec.timing.stepMs;
    return x < 0 ? 0 : x > spec.count - 1 ? spec.count - 1 : x;
  }

  /**
   * Joint angles at t: the 25 Hz grid, linearly interpolated.
   *
   * Linear rather than the cubic the other replay scenes use on their pose tracks. A joint column
   * is a recorded joint-state position measurement sampled at 25 Hz; a Catmull-Rom through it
   * overshoots at every stride reversal, which on a knee is a bend the machine never made.
   */
  function poseJoints(t) {
    const spec = D.meta.tracks.joints;
    const x = uniformIndex(spec, t);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, spec.count - 1);
    const s = x - i0;
    const cols = D.tracks.joints;
    for (let k = 0; k < joints.length; k++) {
      const j = joints[k];
      const col = cols[j.name];
      if (!col) continue;
      const q = col[i0] + (col[i1] - col[i0]) * s;
      j.q = q;
      qTmp.setFromAxisAngle(j.axis, q);
      j.node.quaternion.copy(j.qFixed).multiply(qTmp);
    }
  }

  /** Torso attitude at t: the yaw-free tilt quaternion, slerped on the same 25 Hz grid. */
  function poseTorso(t) {
    const spec = D.meta.tracks.torsoQuaternion;
    const x = uniformIndex(spec, t);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, spec.count - 1);
    const s = x - i0;
    const c = D.tracks.torsoQuaternion;
    qA.set(c.qx[i0], c.qy[i0], c.qz[i0], c.qw[i0]).normalize();
    qB.set(c.qx[i1], c.qy[i1], c.qz[i1], c.qw[i1]).normalize();
    qA.slerp(qB, s);
    torso.quaternion.copy(qA);
  }

  /**
   * Field pose at t: HOLD THEN JUMP.
   *
   * The pose track is the localization output at its native 7.59 Hz, carved into segments at the
   * nine motion-drop warnings, at every covariance spike over the frozen threshold, and around
   * each fall. Inside a segment the estimate is continuous and is interpolated; across a boundary
   * it is NOT, because the filter teleported, and a replay that lerped across the jump would draw
   * a smooth 40 cm slide the robot never walked. So the pose holds at the last sample of the old
   * segment and jumps when the new one starts, which is the frozen consumer rule in FORMAT.md.
   */
  function poseField(t) {
    const p = D.tracks.pose;
    const originMs = D.meta.tracks.pose.timing.timeOriginMs;
    const tMs = t * 1000 - originMs;
    const n = p.tMs.length;
    let i = holdIndexMs(p.tMs, tMs);
    if (i < 0) i = 0; // before the first localization sample: hold the first pose
    const j = Math.min(i + 1, n - 1);
    let x = p.xM[i];
    let y = p.yM[i];
    let yaw = p.yawRad[i];
    if (j !== i && p.segment[j] === p.segment[i]) {
      const span = p.tMs[j] - p.tMs[i];
      const s = span > 0 ? clamp01((tMs - p.tMs[i]) / span) : 0;
      x += (p.xM[j] - x) * s;
      y += (p.yM[j] - y) * s;
      yaw = lerpRad(yaw, p.yawRad[j], s);
    }
    robot.position.set(x, y, 0);
    robot.rotation.set(0, 0, yaw);
  }

  /** Last index of a t-ascending array at or before t. -1 when t precedes all of them. */
  function holdIndexMs(arr, t) {
    if (!arr.length || t < arr[0]) return -1;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Rest the body on the pitch.
   *
   * The recording carries joints, torso attitude and a field (x, y, yaw). It does NOT carry the
   * torso's height off the ground - no channel in this log measures it - so the height is DERIVED
   * here by dropping the assembled body until its lowest contact candidate touches z = 0. That is
   * a rendering choice, not recorded data and not physics: nothing here integrates a contact
   * force, and the robot's pose is whatever the servos actually reported.
   */
  function groundOffset() {
    robot.position.z = 0;
    // Ancestors FIRST: the frame map lives on the root, and reading a world height before the root
    // has a world matrix would measure the ROS lateral axis instead of the vertical one. Then the
    // rig, downward. Both calls are surgical rather than a whole-scene update, and neither
    // allocates.
    root.updateWorldMatrix(true, false);
    robot.updateWorldMatrix(false, true);
    let minY = Infinity;
    for (let k = 0; k < contactPts.length; k++) {
      const c = contactPts[k];
      vTmp.set(c.x, c.y, c.z).applyMatrix4(c.node.matrixWorld);
      if (vTmp.y < minY) minY = vTmp.y;
    }
    // world +y is ROS +z through the root's frame map, and the root is a pure rotation, so the
    // lift measured in world height applies unchanged as a local z translation
    if (Number.isFinite(minY)) robot.position.z = -minY;
    robot.updateWorldMatrix(false, true);
  }

  function poseBall(t) {
    const spec = D.meta.tracks.ballField;
    const x = uniformIndex(spec, t);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, spec.count - 1);
    const s = x - i0;
    const b = D.tracks.ballField;
    // The marker is drawn only between two ticks the mask says the filter actually had an estimate
    // at. A masked tick carries filler ZEROS, so interpolating into one would walk the ball to the
    // centre spot, and holding the last seen one would keep drawing an estimate the filter did not
    // have. Either bracketing tick clear means hidden, full stop.
    if (!(b.ballSeen[i0] > 0.5) || !(b.ballSeen[i1] > 0.5)) {
      ball.visible = false;
      return;
    }
    const bx = b.xM[i0] + (b.xM[i1] - b.xM[i0]) * s;
    const by = b.yM[i0] + (b.yM[i1] - b.yM[i0]) * s;
    const bz = b.zM[i0] + (b.zM[i1] - b.zM[i0]) * s;
    ball.visible = true;
    // z is the estimate's own height and it is occasionally reported at the floor; the marker is a
    // sphere of a real radius, so it rests ON the pitch rather than sinking half into it.
    ball.position.set(bx, by, Math.max(bz, BALL_R));
  }

  function pose(t) {
    if (t === lastPoseT) return;
    lastPoseT = t;
    poseJoints(t);
    poseTorso(t);
    poseField(t);
    groundOffset();
    poseBall(t);
    contact.position.set(robot.position.x, robot.position.y, Z_CONTACT);
    if (halo.visible) halo.position.set(robot.position.x, robot.position.y, Z_HALO);
  }

  /** Where the shot should sit: the torso, in THREE world coordinates. */
  function readFocus(out) {
    torso.getWorldPosition(vTmp);
    out.x = vTmp.x;
    out.y = vTmp.y;
    out.z = vTmp.z;
    return out;
  }

  // ------------------------------------------------------------------ per-frame

  function update(tSec, data) {
    if (!built) {
      if (!data || !data.tracks || !data.tracks.joints || !data.meta || !data.meta.tracks || !data.events) return;
      build(data);
    }
    const t = clampT(Number.isFinite(tSec) ? tSec : 0);
    pose(t);
    lastFocus = readFocus(focusOut);
    if (highlight) driveHighlight(t);
  }

  function driveHighlight(t) {
    const pulse = 0.3 + Math.abs(Math.sin(t * 4.2)) * 0.55;
    halo.material.opacity = pulse * 0.8;
    for (let i = 0; i < shellMats.length; i++) shellMats[i].emissiveIntensity = pulse * 0.5;
  }

  // ------------------------------------------------------------------ HUD contract

  /**
   * The referee strip at t, version-keyed so the viewer only touches the DOM on a transition.
   *
   * WHERE EACH FIELD COMES FROM, because the two sources are not interchangeable:
   *   * the NUMBERS - clock, both scores - are read off the recorded /game channel, the same 2 Hz
   *     zero-order-held grid the chart plots. One source, so the strip and the chart can never
   *     disagree about the score.
   *   * the STATE MACHINE - penalized, READY/SET, FINISHED, and the goal callout - comes off the
   *     frozen event ledger, because the exported /game columns carry no game-state enum at all.
   * The ledger's instants are the recorded message times, so the goal note opens exactly at
   * 278.197 s while the score digit turns over on the next 2 Hz tick that saw it. That half-second
   * is the resampling grid, not a disagreement, and it is here in writing rather than tuned away.
   */
  let hudGameI = -2;
  let hudNote = null;
  let hudLabel = null;
  function hudState(tSec) {
    if (!built) return null;
    const t = clampT(Number.isFinite(tSec) ? tSec : 0);
    const spec = D.meta.tracks.summaryGame;
    const g = D.tracks.summaryGame;
    // FLOOR, not nearest: /game is a zero-order-held grid, so the strip shows the last recorded
    // tick at or before t. Rounding to the nearest would show a score half a second before the
    // recording knew it.
    const i = Math.floor(uniformIndex(spec, t) + 1e-6);

    let label = 'PLAYING';
    let tone = 'live';
    let note = '';
    if (t >= evWhistleT) {
      label = 'FINISHED';
      tone = 'goal';
    } else if (evBlip && t >= evBlip.t && t <= evBlip.endT) {
      label = 'READY/SET';
      tone = 'prep';
    }
    if (t < evPenaltyT) {
      // The opening window: the robot re-entered from a penalty at the ledger's first row, so
      // everything before that instant is a penalized robot standing off the pitch's play.
      note = 'penalized';
    } else if (evGoal && t >= evGoal.t && t < evGoal.t + GOAL_NOTE_S) {
      note = 'GOAL 2-0';
    }

    // Short-circuit on the three things any rendered field can move with: the /game tick, the note
    // and the label. Without it this rebuilds five strings sixty times a second for a strip that
    // changes a handful of times a minute.
    if (i === hudGameI && note === hudNote && label === hudLabel) return hud;
    hudGameI = i;
    hudNote = note;
    hudLabel = label;

    const own = Math.round(g.ownScore[i]);
    const rival = Math.round(g.rivalScore[i]);
    hud.teams[0].score = own;
    hud.teams[1].score = rival;
    hud.clock = clockText(g.secondsRemaining[i]);
    hud.state.label = label;
    hud.state.tone = tone;
    hud.state.note = note;

    // EVERY rendered field is in the key, the two constant names and dot colours included. A field
    // that moved while the version did not would sit stale behind the viewer's short-circuit.
    hud.version =
      hud.clock +
      '|' + own + ':' + rival +
      '|' + label +
      '|' + tone +
      '|' + note +
      '|' + hud.teams[0].name + '/' + hud.teams[0].color +
      '|' + hud.teams[1].name + '/' + hud.teams[1].color;
    return hud;
  }

  // ------------------------------------------------------------------ camera + highlight

  /**
   * With an argument: where the robot is at that moment. Without one, this is the picker card
   * asking where the machine IS at the moment it was just posed at, so it answers with the last
   * update()'s focus and falls back to the frozen hero moment, which is upright and mid-walk.
   */
  function cameraFocus(tSec) {
    if (!built) return null;
    if (Number.isFinite(tSec)) {
      pose(clampT(tSec));
      return readFocus(focusOut);
    }
    return lastFocus || heroFocus;
  }

  // One robot on a 9 x 6 m pitch, walking at well under 0.5 m/s, on a pose track that legitimately
  // jumps at segment boundaries: a softer spring than battle's, and a snap threshold just above the
  // largest honest frame-to-frame move so a localization jump cuts instead of whipping.
  const followTuning = { omega: 2.6, lead: 0.18, snap: 0.9 };

  function applyHighlight() {
    const on = !!highlight;
    for (let i = 0; i < shellMats.length; i++) {
      shellMats[i].emissive.setHex(on ? ALERT : 0x000000);
      shellMats[i].emissiveIntensity = on ? 0.4 : 0;
    }
    for (let i = 0; i < accentMats.length; i++) {
      accentMats[i].emissiveIntensity = on ? 0.6 : 0.35;
    }
    halo.visible = on;
    halo.material.opacity = on ? 0.4 : 0;
    if (on) halo.position.set(robot.position.x, robot.position.y, Z_HALO);
  }

  /**
   * `body` is what every finding in data.js points at, and it is the honest granularity: the
   * findings are falls, battery sag, servo clamps and a match result, none of which belong to one
   * limb. `head`, `arms` and `legs` are accepted so a later finding can narrow without a scene
   * change; anything else clears.
   */
  function setHighlight(partId) {
    highlight = partId && /^(body|head|arms|legs)$/.test(partId) ? partId : null;
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
    links = null;
    joints = null;
    robot = null;
    torso = null;
    ball = null;
    contact = null;
    halo = null;
    shellMats = [];
    accentMats = [];
    contactPts = [];
    evGoal = null;
    evBlip = null;
    evWhistleT = Infinity;
    lastFocus = null;
    heroFocus = null;
    highlight = null;
    hudGameI = -2;
    hudNote = null;
    hudLabel = null;
    lastPoseT = null;
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
    // The viewer's default rig is wrong for an 11 x 8 m pitch with its own turf: an 80 m ground
    // plane and two 60 m grids would sit under the field, and a 1024^2 shadow map over an 18 m
    // frustum is ~18 mm/texel, which on a 0.09 m foot is a smear. Grounding is the baked contact
    // patch instead, and every mesh here sets castShadow = false.
    rendering: {
      ground: false,
      grids: false,
      shadow: false,
      fog: { color: 0x0e1114, near: 12, far: 42 },
    },
  };
}
