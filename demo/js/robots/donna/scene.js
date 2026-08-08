// donna/scene.js - Donna, Jack and Rory's recorded RoboCup German Open 2025 match, replayed on a
// KidSize field with the official Wolfgang-OP CAD body.
//
// Nothing here is simulated. Each robot's joint columns are RECORDED `/joint_states.position`
// measurements from ITS OWN onboard rosbag2 log, not commands, and the display interpolates between
// their samples (Donna 25 Hz, Jack and Rory 10 Hz). Torso attitude and field position come from
// recorded tracks. The ball comes from Donna's filtered recorded estimate in the map frame, with
// rendered z clamped to the ball radius for ground contact. Torso HEIGHT is derived because the
// logs record joints, attitude and (x, y, yaw) on the field but never how far the hips are off the
// ground. See groundOffset() for exactly how that number is produced and why.
//
// FRAMES. The payload is in the ROS FLU field frame the Bit-Bots localization publishes: x along
// the 9 m touch line, y left, z up, origin at the centre mark, yaw CCW about +z from +x. three.js
// is y-up, so the scene ROOT carries the frozen frame map from FORMAT-V2.md (META.scene.frameMap)
//
//     three.x = -ros.y
//     three.y =  ros.z
//     three.z = -ros.x
//
// and EVERYTHING inside the root - field, goals, lines, ball, bodies - is authored in ROS metres.
// The map is a proper rotation (det = +1), so winding and normals survive it untouched. Putting it
// on the root rather than open-coding it at every call site is what makes the frame contract one
// testable object instead of a hundred and thirty-three conversions.
//
// YAW IS APPLIED EXACTLY ONCE. Heading comes from the segmented localization pose and nothing else.
// The torso quaternion in the payload is the yaw-FREE tilt quaternion the extractor froze: it
// rotates world vertical onto the torso up axis and its z component is identically zero. So each
// robot group carries `rotation.z = poseYaw` and its torso node carries the tilt, and no yaw is
// ever applied a second time. One honest consequence, recorded here rather than hidden: the tilt
// quaternion's lean AXIS was expressed in that robot's own drifting IMU yaw reference, which the
// extractor discarded with the yaw, so the lean is rendered inside the localization heading. The
// lean ANGLE is exact; the lean AZIMUTH is only as good as the two yaw references agreeing.
//
// THE BODY IS THE REAL CAD. The heavy module ships the MIT-licensed Wolfgang-OP visual meshes
// (bit-bots/wolfgang_robot @ b067cae, (c) Hamburg Bit-Bots) as quantized columns: 52 unique meshes,
// 4,361 vertices, 8,922 unique triangles, placed by a frozen 133-row visual-instance manifest whose
// every placement is PRE-COMPOSED at build time into one of 21 driven buckets - the 20 revolute
// joints plus ROOT/TORSO, which carries the 24 placements that hang off `torso` and has no revolute
// ancestor. The runtime contract is exactly
//
//     instanceWorld = boneWorld[drivenAncestor] * preComposedInstanceTransform
//
// and this file honours it by BAKING each pre-composed transform into the vertices of a merged
// per-(bucket, material class) geometry, then parenting that merged geometry to the bucket's node.
// Baking a rigid transform into vertices and parenting to the same node is the same world matrix
// with 42 draw calls per body instead of 133, and the merge is built ONCE and shared by all three
// robots, which is what keeps three CAD humanoids at ~63k triangles and ~145 draw calls.
//
// PRESENCE IS THREE CLASSES, NOT A BOOLEAN (FORMAT-V2 "Presence tracks"). A robot is only drawn
// where its own log actually observed it:
//   * LIVE      - normal replay, pose interpolated inside the live segment.
//   * HOLD      - Jack's three fall outages. His localization drops while his joints, IMU and
//                 robot_state keep streaming, so the recorded fall ANIMATION plays at his last
//                 observed root pose. The HUD chip says "fallen" for exactly that interval.
//   * HIDDEN    - Donna's penalty (86.85-124.10, physically off the field) and Rory before her
//                 first map fix (0-28.27). There is no observed pose, so there is no body on the
//                 pitch, and the HUD chip says why. An unobserved pose is never rendered as
//                 observed and is never back-filled.
//
// NO `document`. Every surface in this file is untextured geometry or a DataTexture - the name tags
// included, which is why they are a hand-rolled 5x8 bitmap font rather than a canvas - so
// buildScene() runs unchanged inside Node against the vendored three, which is what lets the pose
// and HUD contracts be proven by plain `node` tests instead of by a browser nobody installs.
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
const Z_RING = 0.0040;
const Z_HALO = 0.0048;

// ---------------------------------------------------------------------------- rig
//
// FROZEN. The 20 revolute joints of the Wolfgang-OP, transcribed from `rig/RIG.json`, which the
// Phase 0 extractor pulled out of the MIT-licensed `bit-bots/wolfgang_robot` URDF (c) Hamburg
// Bit-Bots. Names match `/joint_states.name` exactly, they are the payload's own column order, and
// they are ALSO the 20 driven-bucket names in the visual-instance manifest.
//
// Each row is [name, parent link, child link, origin xyz, origin rpy, axis]. `rpy` is the URDF
// convention R = Rz(yaw) Ry(pitch) Rx(roll), which is three's Euler order 'ZYX'. Exporter float
// noise below 1e-6 rad/m (terms like 1.66533e-15) is written as an exact zero; every digit that
// carries meaning is verbatim, including the ones that are NOT mirror-symmetric between the left
// and right sides - LKnee's 2.87979 rad origin yaw, RKnee's -0.261799 rad origin pitch and
// RAnkleRoll's 1.54833 rad origin pitch are all really in the URDF, and a "tidied" symmetric rig
// would bend these robots' legs differently from the machines that recorded the logs.
//
// The three robots are the same hardware and the Phase 0 scans confirmed identical joint-name
// inventories across all three logs, so ONE rig table drives all three bodies.
//
// `limit` is carried for reference only and is NEVER used to clamp: the hardware interface's own
// limit config differs from the URDF's, and a replay that silently clamped a recorded angle would
// be showing a pose the machine did not hold.
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

const ROOT_BUCKET = 'ROOT/TORSO';

// ---------------------------------------------------------------------------- palette
//
// House 3D style: the CAD's own two material classes (a light printed/milled shell and the dark
// Dynamixel and camera bodies), one accent per robot, emissive used only where a real machine
// emits. The accents are three of the page's own brand tokens - Donna keeps the alloy blue the v1
// scene and the picker card carry, Jack takes the sage and Rory the amber - and they are a REPLAY
// affordance, not a recorded team marking: these three robots are all on the same team and the log
// exports no per-robot colour. The two HUD dot colours are the strip's own two-team affordance for
// the same reason, which is also why the second team is called "Opponent" rather than named.
const SHELL_LIGHT = 0xc9ced5;
const SHELL_DARK = 0x1c1f24;
const TURF = 0x22402b;
const TURF_BORDER = 0x1a3222;
const LINE = 0xeef1f3;
const GOAL_FRAME = 0xe8ecef;
const NET = 0x94a6b8;
const BALL_LIGHT = 0xe9ecee;
const BALL_DARK = 0x22262b;
const ALERT = 0xff5f57;
const TAG_INK = 0xf2f5f8;
const TAG_BACK = [14, 16, 20, 176]; // rgba bytes behind the glyphs

// ---- name tags on the anatomy step
//
// A name tag is a WIDE-SHOT device: 0.34 m of sprite riding over the hips is what makes three
// identical white humanoids identifiable at the follow cam's 7.4 m, and it is unusable on a step
// that closes to half a metre, where "Donna" is wider than the phone panel and was measured lying
// across 88% of the live anatomy card with the card's copy reading through the glyphs. So the tags
// stand down while an anatomy overlay is live on this scene. `experience.js` (which authors the
// tour, and is lazy) states the policy and keeps the argument for it; a session where that module
// never loads keeps the legacy brief's labels exactly as they shipped.
//
// LIVE means "this instance's anchors are being read". The viewer's ABI has no step flag, and this
// file has no DOM (see NO `document` above), but the overlay resolves every leader and every camera
// beat through `anchors()` - so a scene whose closures were read within the last twelve frames is
// the scene an overlay is drawing. Per-instance by construction, and it lapses by itself when the
// step closes. Reduced motion projects ONCE and holds still, which is not a heartbeat, so that
// visitor keeps the tags on the static hero pose the step ships for them.
const ANCHOR_LIVE_MS = 200;
const TAG_FADE_MS = 240;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
let tagsStandDownOnAnatomy = false;

/**
 * Declare that this mission's anatomy step is a directed close-range tour, so every robot's name tag
 * stands down for the duration of it. Called by `experience.js` and by nobody else.
 *
 * Module scope because it is one statement about this mission's step and every instance built here
 * is that mission; WHICH instance stands its tags down is decided per-instance, above.
 *
 * @param {boolean} [on]
 */
export function holdNameTagsOnAnatomy(on = true) {
  tagsStandDownOnAnatomy = on !== false;
}

/**
 * The three recorded robots, in the payload's own robot order. `accent` is the identity colour;
 * `label` is the approved factual robot name and is what the floating tag and the HUD chip say.
 */
const ROBOTS = [
  { key: 'donna', label: 'Donna', accent: 0x2f78ff },
  { key: 'jack', label: 'Jack', accent: 0xd3eeb6 },
  { key: 'rory', label: 'Rory', accent: 0xf5a623 },
];

// ---------------------------------------------------------------------------- camera
//
// The shot is framed for the follow spring, not for a static wide: the viewer translates camera
// and target together, so this OFFSET is the follow framing and "reset view" recentres it on
// whatever the three robots are doing. |offset| = 7.4 m at 33 deg elevation, sitting off the -y
// touch line so the 9 m long axis runs across the frame - which is the axis the three robots
// actually spread along (5.1 m apart at the hero moment) - and swung slightly toward the -x goal so
// the shot is not dead side-on. That is more than twice v1's 3.4 m, and it has to be: v1 framed ONE
// 0.8 m machine, and a follow shot tight enough for one robot cannot hold three. At the hero moment
// the outermost two land at +-0.7 of frame width on a phone panel and +-0.4 on the desktop one, so
// nobody is on the edge in either. Expressed in THREE coordinates, because the viewer applies it to
// its own camera and never sees the ROS frame.
export const cameraHome = {
  position: { x: 6.2, y: 4.4, z: 0.8 },
  target: { x: 0, y: 0.4, z: 0 },
};

// The frozen healthy-hero moment (CONTRACTS-V2 "Hero"): all three present with a live pose,
// upright, un-penalized, Donna WALKING with the ball seen, no fall within 5 s for anyone.
const HERO_T = 187.6;

// ---------------------------------------------------------------------------- event ids
//
// The scene reads exactly two rows out of the frozen 20-row ledger, by id, for the goal callout.
// It reads them by ID and not by index so a re-ordered ledger fails loudly instead of rendering the
// wrong instant. Everything else on the strip - the clock, both scores, the match state and every
// per-robot chip - comes off the recorded HUD and presence tracks, so the ledger is a caption
// source here and never a state machine.
const EV_GOAL_1 = 'goal-5-0';
const EV_GOAL_2 = 'goal-6-0';
const GOAL_NOTE_S = 3.0; // how long a goal callout stands on the strip after its recorded instant

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
 * negative for its last stretch while secondary_state remains STATE_NORMAL. Negative renders as
 * added time with a leading "+", which is what the referee display shows and what the copy quotes
 * (the 6-0 goal lands at clock -31, the whistle at -33).
 */
function clockText(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const neg = sec < 0;
  const s = Math.abs(Math.round(sec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${neg ? '+' : ''}${mm}:${ss < 10 ? '0' : ''}${ss}`;
}

/** Last index of an ascending array at or before `v`. -1 when `v` precedes all of them. */
function holdIndex(arr, v) {
  if (!arr.length || v < arr[0]) return -1;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------- geometry batcher

/**
 * Accumulates untextured triangles so the pitch and the goals land in a handful of draw calls. All
 * coordinates are ROS FLU metres; the root's frame map does the rest. The bodies do NOT come
 * through here - they are the decoded CAD - so this is field furniture only.
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

// ---------------------------------------------------------------------------- textures
//
// Everything below writes raw bytes into a DataTexture. The other replay scenes paint theirs into a
// canvas, which needs `document`; these are generated as bytes so the whole scene stays
// constructible in Node and the pose and HUD contracts can be proven without a browser.

/** A soft round contact patch. */
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

/**
 * A 5x8 bitmap font, covering EXACTLY the ten glyphs the three approved robot names need
 * (Donna / Jack / Rory) and nothing else. A face rather than a canvas because this file may not
 * touch `document`; ten glyphs rather than an alphabet because the names are frozen copy and a
 * font nobody can read at 30 px of tag is a bigger problem than a font that only spells three
 * words. An unknown character renders as blank space rather than as tofu.
 */
const GLYPHS = {
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.', '.....'],
  J: ['..###', '....#', '....#', '....#', '#...#', '#...#', '.###.', '.....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#', '.....'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####', '.....'],
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.', '.....'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '.....'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#', '.....'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.', '.....'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....', '.....'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
};
const GLYPH_W = 5;
const GLYPH_H = 8;

/**
 * A robot's floating name tag as a DataTexture: dark plate, the name in the accent-lit ink, one
 * accent rule under it. Drawn at 4x so the sprite has resolution to spare at follow-cam distance
 * without any of the glyph edges being resampled into mush.
 */
function nameTagTexture(THREE, name, accent) {
  const PX = 4;
  const PAD = 6;
  const advance = GLYPH_W + 1;
  const inkW = name.length * advance - 1;
  const W = PAD * 2 + inkW * PX;
  const H = PAD * 2 + (GLYPH_H + 2) * PX;
  const data = new Uint8Array(W * H * 4);
  const ar = (accent >> 16) & 255;
  const ag = (accent >> 8) & 255;
  const ab = accent & 255;
  const ir = (TAG_INK >> 16) & 255;
  const ig = (TAG_INK >> 8) & 255;
  const ib = TAG_INK & 255;

  // plate
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = TAG_BACK[0];
    data[i * 4 + 1] = TAG_BACK[1];
    data[i * 4 + 2] = TAG_BACK[2];
    data[i * 4 + 3] = TAG_BACK[3];
  }
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    // the DataTexture's first row is the BOTTOM row in three's UV convention, so the glyph rows
    // (which are authored top-down like every bitmap font) are flipped on the way in
    const k = ((H - 1 - y) * W + x) * 4;
    data[k] = r;
    data[k + 1] = g;
    data[k + 2] = b;
    data[k + 3] = a;
  };
  const block = (px, py, r, g, b, a) => {
    for (let dy = 0; dy < PX; dy++) for (let dx = 0; dx < PX; dx++) put(PAD + px * PX + dx, PAD + py * PX + dy, r, g, b, a);
  };

  for (let c = 0; c < name.length; c++) {
    const rows = GLYPHS[name[c]];
    if (!rows) continue;
    for (let y = 0; y < GLYPH_H; y++) {
      const row = rows[y];
      for (let x = 0; x < GLYPH_W; x++) {
        if (row[x] !== '#') continue;
        block(c * advance + x, y, ir, ig, ib, 255);
      }
    }
  }
  // the accent rule, one glyph-pixel tall, the full width of the ink
  for (let x = 0; x < inkW; x++) block(x, GLYPH_H + 1, ar, ag, ab, 255);

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.userData = { aspect: W / H };
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
  // Whether the CAD baked into the merged geometry came from the DECIMATED PROXY lane. Set once at
  // build() from the payload the geometry was built from, and never re-read afterwards, because a
  // later rebind swaps tracks and not vertices. See proxyMesh().
  let isProxy = false;
  let bots = null; // per-robot runtime, in ROBOTS order
  let ball = null;
  let evGoal1 = null;
  let evGoal2 = null;
  let highlight = null;
  let lastFocus = null;
  let heroFocus = null;
  // The follow spring asks cameraFocus() for the SAME instant update() was just handed, so the
  // posed moment is cached: without it every frame poses three whole rigs twice.
  let lastPoseT = null;
  // Name-tag stand-down, per instance. See holdNameTagsOnAnatomy(): `anchorReadAt` is the wall clock
  // of the last anatomy-anchor read, which is this scene's evidence that an overlay is live on it,
  // and `tagFade` is the opacity all three tags are currently carrying.
  let anchorReadAt = 0;
  let tagFade = 1;
  let tagFadeAt = 0;

  const vTmp = new THREE.Vector3();
  const qTmp = new THREE.Quaternion();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const focusOut = { x: 0, y: 0.3, z: 0 };
  const heroOut = { x: 0, y: 0.3, z: 0 };

  // Allocated ONCE and mutated in place: the strip renders off `version`, and a producer that
  // reallocated would churn a fresh object sixty times a second for a string that changes a handful
  // of times a minute.
  //
  // Note which keys are ABSENT. RoboCup Humanoid League has no yellow/red card state, no timeout
  // count and no max-bots limit on this wire, and the logs export no goalkeeper id and no half
  // indicator, so `cards`, `reds`, `timeouts`, `maxBots`, `keeper` and `stage` are not on these
  // objects at all. viewer.js renders nothing for a field a team does not define, and sending any
  // of them as a zero would put a truthful-looking "0Y" on the strip for a league with no cards.
  //
  // `chips` and `chipsAbi` are the ADDITION this mission makes to the strip contract. Three robots
  // replayed from three logs need three presence statements, and one shared `state.note` cannot
  // carry them. `chipsAbi` is the version guard viewer.js checks: a viewer that does not know the
  // chip ABI ignores both keys and renders exactly the strip it always did, and the six missions
  // that do not send chips never reach the chip code path at all.
  const hud = {
    version: '',
    clock: '--:--',
    state: { label: 'PLAYING', tone: 'live', note: '' },
    teams: [
      { name: 'Bit-Bots', color: 'blue', score: 0 },
      { name: 'Opponent', color: 'red', score: 0 },
    ],
    chipsAbi: 1,
    chips: ROBOTS.map((r) => ({ name: r.label, state: '', note: '', tone: 'live' })),
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

  // ------------------------------------------------------------------ the CAD body

  /**
   * Does this payload's mesh come from the decimated PROXY lane rather than the full CAD?
   *
   * It matters for exactly one reason, and the reason is a measured defect rather than a taste
   * call: the proxy decimation leaves 14 of the 52 parts with boundary or non-manifold edges and
   * two parts (`torso_bottom`, `lower_leg_spacer`) with inverted or zero signed volume, so a
   * single-sided material renders them with holes where a backface faces the camera. The full mesh
   * is clean and stays FrontSide, which is a real saving at 63k triangles across three bodies.
   *
   * The flag is read off BOTH surfaces a producer could reasonably put it on - the decoded mesh
   * object (`data.mesh.proxy`, which decodeMesh sets from the module's declared mesh format) and
   * the module's own `META.mesh` - and the preview lane really does ship a proxy today:
   * `preview-data.js` declares `META.mesh.proxy = true` with format
   * `wolfgang-mesh-columns-proxy/1` (645 vertices, 1072 triangles), so the picker's preview takes
   * this branch and renders every body material DoubleSide. The full module stays
   * `wolfgang-mesh-columns/1` (4361 vertices, 8922 triangles) with `proxy = false`, so the viewer
   * renders it FrontSide.
   */
  function proxyMesh(data) {
    return !!((data.mesh && data.mesh.proxy) || (data.meta && data.meta.mesh && data.meta.mesh.proxy));
  }

  /**
   * 26 directions on the unit sphere: the 3x3x3 integer lattice without its centre. Used to pull a
   * bucket's EXTREME vertices out of the decoded CAD as ground-contact candidates.
   */
  const HULL_DIRS = (() => {
    const out = [];
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          if (!i && !j && !k) continue;
          const len = Math.hypot(i, j, k);
          out.push([i / len, j / len, k / len]);
        }
      }
    }
    return out;
  })();

  /**
   * Merge the 133 pre-composed visual instances into one geometry per (driven bucket, material
   * class), and pull each bucket's ground-contact candidates out of the merged vertices.
   *
   * THE CONTRACT. `META.mesh.visualInstances.convention` states
   * `instance_world = bone_world[driven_ancestor] @ T(translation, quaternion_wxyz)`, with every
   * FIXED joint between the driven ancestor and the visual origin already baked into that stored
   * transform. `bone_world[<joint>]` is the joint's child-link frame AFTER its revolute rotation,
   * which is exactly the node buildRig() creates for that joint; `bone_world[ROOT/TORSO]` is the
   * base pose, which is exactly the torso node the field pose and the IMU tilt drive.
   *
   * So the transform is applied HERE, once, to the vertices, and the merged result is parented to
   * that node. Same world matrix, 42 draw calls per body instead of 133, and one geometry set
   * shared by all three robots instead of three copies of the same 20,902 triangles.
   *
   * The merged geometries are returned UNSHADED: material choice is per robot, because each robot
   * carries its own accent tint and its own highlight state.
   */
  function buildMeshLibrary(mesh, buckets) {
    const lib = {};
    const bucketNames = Object.keys(buckets);
    for (const bucket of bucketNames) lib[bucket] = { geo: {}, contacts: [] };

    // group instances by bucket, then by material class
    const grouped = {};
    for (const inst of mesh.instances) {
      const b = grouped[inst.bucket] || (grouped[inst.bucket] = {});
      (b[inst.materialClass] || (b[inst.materialClass] = [])).push(inst);
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);

    for (const bucket of bucketNames) {
      const byClass = grouped[bucket] || {};
      // every vertex of this bucket, in bucket-local space, for the contact solve
      const allX = [];
      const allY = [];
      const allZ = [];
      for (const cls of Object.keys(byClass)) {
        const list = byClass[cls];
        let nVerts = 0;
        let nIdx = 0;
        for (const inst of list) {
          const part = mesh.parts[inst.part];
          nVerts += part.positions.length / 3;
          nIdx += part.indices.length;
        }
        const positions = new Float32Array(nVerts * 3);
        const normals = new Float32Array(nVerts * 3);
        const indices = nVerts > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
        let vo = 0; // vertex offset, in vertices
        let io = 0; // index offset
        for (const inst of list) {
          const part = mesh.parts[inst.part];
          const t = inst.translation;
          const qw = inst.quaternionWxyz;
          q.set(qw[1], qw[2], qw[3], qw[0]);
          v.set(t[0], t[1], t[2]);
          m4.compose(v, q, one);
          const n = part.positions.length / 3;
          for (let i = 0; i < n; i++) {
            vTmp.set(part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]);
            vTmp.applyMatrix4(m4);
            positions[(vo + i) * 3] = vTmp.x;
            positions[(vo + i) * 3 + 1] = vTmp.y;
            positions[(vo + i) * 3 + 2] = vTmp.z;
            allX.push(vTmp.x);
            allY.push(vTmp.y);
            allZ.push(vTmp.z);
            // the pre-composed transform is a pure rotation plus a translation, so a normal is
            // rotated and nothing else - no inverse-transpose, no renormalisation
            vTmp.set(part.normals[i * 3], part.normals[i * 3 + 1], part.normals[i * 3 + 2]);
            vTmp.applyQuaternion(q);
            normals[(vo + i) * 3] = vTmp.x;
            normals[(vo + i) * 3 + 1] = vTmp.y;
            normals[(vo + i) * 3 + 2] = vTmp.z;
          }
          // index order and winding are binding (FORMAT-V2 `uint16-absolute-le`): the source stream
          // is copied through with nothing but the vertex-base offset added
          for (let i = 0; i < part.indices.length; i++) indices[io + i] = part.indices[i] + vo;
          vo += n;
          io += part.indices.length;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        g.setIndex(new THREE.BufferAttribute(indices, 1));
        lib[bucket].geo[cls] = keep(g);
      }

      // ---- ground-contact candidates.
      //
      // The extreme vertex of this bucket along each of 26 directions, de-duplicated. They are REAL
      // vertices of the real CAD, never bounding-box corners: a box corner sits below the surface
      // it bounds, and a solve that took its minimum over box corners would lift the body off the
      // pitch by the error. A 26-direction sample can UNDER-lift by a millimetre or two when the
      // true lowest vertex sits between two sampled directions, which is the forgiving side of the
      // trade, and it is a rendering choice either way (see groundOffset()).
      const seen = new Set();
      for (const d of HULL_DIRS) {
        let best = -Infinity;
        let bi = -1;
        for (let i = 0; i < allX.length; i++) {
          const dot = allX[i] * d[0] + allY[i] * d[1] + allZ[i] * d[2];
          if (dot > best) {
            best = dot;
            bi = i;
          }
        }
        if (bi >= 0 && !seen.has(bi)) {
          seen.add(bi);
          lib[bucket].contacts.push([allX[bi], allY[bi], allZ[bi]]);
        }
      }
    }
    return lib;
  }

  /**
   * The kinematic tree: one node per revolute joint, whose transform is exactly the URDF's fixed
   * origin composed with the rotation about the joint axis, hung off a torso node that carries the
   * base pose and the IMU tilt. That is the whole runtime rig - 20 revolute joints plus the root
   * bucket - because every fixed-joint chain in the 47-link URDF is already baked into the
   * pre-composed instance transforms.
   */
  function buildRig(key) {
    const links = {};
    const joints = [];
    const torsoNode = new THREE.Group();
    torsoNode.name = `${key}:torso`;
    links.torso = torsoNode;

    for (const [name, parent, child, xyz, rpy, axis] of RIG) {
      const node = new THREE.Group();
      node.name = `${key}:${child}`;
      node.position.set(xyz[0], xyz[1], xyz[2]);
      // URDF rpy is R = Rz(yaw) Ry(pitch) Rx(roll), which is three's Euler order 'ZYX'
      const qFixed = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX')
      );
      node.quaternion.copy(qFixed);
      links[parent].add(node);
      links[child] = node;
      joints.push({
        name,
        node,
        qFixed,
        axis: new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(),
        q: 0,
      });
    }
    return { torsoNode, joints };
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

  /**
   * One robot: rig, merged CAD body, name tag, ground decals, materials.
   *
   * The name tag is a SPRITE, which is the one thing in three that faces the camera without this
   * file being handed one - buildScene() never sees the viewer's camera, and a fixed-orientation
   * quad would read backwards the moment anybody orbited. It depth-tests like any other surface, so
   * a body standing in front of a tag occludes it instead of the label floating through the robot.
   */
  function buildRobot(spec, lib, contactTex) {
    const { torsoNode, joints } = buildRig(spec.key);

    const group = new THREE.Group();
    group.name = `${spec.key}:robot`;
    group.add(torsoNode);
    root.add(group);

    // The CAD's two material classes, per robot so each body can carry its own accent and its own
    // highlight. The light shell is tinted 10% toward the accent: enough that three identical
    // machines are three identifiable machines at follow-cam distance, little enough that the body
    // still reads as the near-white printed shell the CAD actually is.
    // `side` is the ONLY thing the proxy branch changes. Everything else about these two materials
    // is identical on both lanes, so a proxy body is the same body with its backfaces filled in.
    const side = isProxy ? THREE.DoubleSide : THREE.FrontSide;
    const light = keep(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(SHELL_LIGHT).lerp(new THREE.Color(spec.accent), 0.1),
        roughness: 0.52,
        metalness: 0.14,
        emissive: 0x000000,
        side,
      })
    );
    const dark = keep(
      new THREE.MeshStandardMaterial({
        color: SHELL_DARK,
        roughness: 0.7,
        metalness: 0.28,
        emissive: 0x000000,
        side,
      })
    );
    const mats = { light, dark };

    const bucketNodes = { [ROOT_BUCKET]: torsoNode };
    for (const j of joints) bucketNodes[j.name] = j.node;

    const contactPts = [];
    for (const bucket of Object.keys(lib)) {
      const node = bucketNodes[bucket];
      if (!node) continue; // a bucket with no node would be a rig/manifest disagreement
      for (const cls of Object.keys(lib[bucket].geo)) {
        const mesh = new THREE.Mesh(lib[bucket].geo[cls], mats[cls] || light);
        mesh.name = `${spec.key}:${bucket}:${cls}`;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        node.add(mesh);
      }
      for (const c of lib[bucket].contacts) contactPts.push({ node, x: c[0], y: c[1], z: c[2] });
    }

    // ---- the two electronics modules the anatomy cards name
    //
    // The IMU behind /imu and the computer behind /compute are real hardware on this machine and the
    // Bit-Bots CAD has neither, so the two cards naming them used to point at bare torso shell.
    // Boxes on the torso link at their own anchor heights (0.15 and 0.04, see the anchor block
    // below), mounted on the front of the chest frame and in the open lower cage so a frontal shot
    // and the tour's highlight land on them. Dark shell, and no claim beyond "a box is bolted here".
    //
    // The x offsets are measured, not chosen: down the centreline (|y| < 0.035) the CAD's own front
    // surface reaches x = 0.0497 across the IMU's z band and 0.0580 across the computer's, so each
    // box's back face is inside that surface and its front stands 13 mm proud of it. Further out and
    // they float in front of an open cage; further in and they are behind it.
    const modules = [
      [0.056, 0, 0.15, 0.014, 0.036, 0.026],
      [0.06, 0, 0.045, 0.022, 0.054, 0.038],
    ].map(([x, y, z, dx, dy, dz]) => {
      const m = new THREE.Mesh(keep(new THREE.BoxGeometry(dx, dy, dz)), dark);
      m.position.set(x, y, z);
      torsoNode.add(m);
      return m;
    });

    // ---- floating name tag
    const tagTex = keep(nameTagTexture(THREE, spec.label, spec.accent));
    const tagMat = keep(
      new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthWrite: false, fog: false })
    );
    const tag = new THREE.Sprite(tagMat);
    tag.name = `${spec.key}:tag`;
    const TAG_H = 0.13;
    tag.scale.set(TAG_H * tagTex.userData.aspect, TAG_H, 1);
    // The group's origin is the robot's base pose, which groundOffset() lifts to hip height, and
    // the CAD's head tops out ~0.38 m above it standing. 0.50 clears that by a comfortable margin
    // and rides DOWN with the body when a robot falls, so the label follows its machine instead of
    // hanging at a fixed altitude over an empty patch of pitch.
    tag.position.set(0, 0, 0.5);
    tag.renderOrder = 4;
    group.add(tag);

    // ---- ground decals: the soft contact patch every replay scene grounds its subject with, plus
    // a thin accent ring so a robot's identity survives the tag being occluded.
    const cm = keep(
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: contactTex,
        transparent: true,
        opacity: 0.46,
        depthWrite: false,
      })
    );
    const contact = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.44, 0.44)), cm);
    contact.name = `${spec.key}:contact`;
    contact.position.z = Z_CONTACT;
    contact.renderOrder = 1;
    root.add(contact);

    const rm = keep(
      new THREE.MeshBasicMaterial({
        color: spec.accent,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const ring = new THREE.Mesh(keep(new THREE.RingGeometry(0.2, 0.225, 40)), rm);
    ring.name = `${spec.key}:ring`;
    ring.position.z = Z_RING;
    ring.renderOrder = 2;
    root.add(ring);

    const hm = keep(
      new THREE.MeshBasicMaterial({
        color: ALERT,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const halo = new THREE.Mesh(keep(new THREE.RingGeometry(0.28, 0.36, 48)), hm);
    halo.name = `${spec.key}:halo`;
    halo.position.z = Z_HALO;
    halo.renderOrder = 3;
    halo.visible = false;
    root.add(halo);

    return {
      key: spec.key,
      label: spec.label,
      accent: spec.accent,
      group,
      torso: torsoNode,
      joints,
      mats,
      modules,
      contactPts,
      tag,
      contact,
      ring,
      halo,
      // filled by bindTracks()
      presence: null,
      poseSegs: null,
      jointsSpec: null,
      jointsCols: null,
      quatSpec: null,
      quatCols: null,
      stateT: null,
      stateV: null,
      hudCols: null,
      mode: 'LIVE',
      x: 0,
      y: 0,
    };
  }

  // ------------------------------------------------------------------ track binding

  /**
   * Point the runtime at a decoded payload's tracks.
   *
   * Separate from build() because the two decoded variants carry the SAME 133-instance CAD and the
   * same rig but different tracks: the picker card stages this scene off the 6 s preview module and
   * the demo route re-binds it to the full 250 s match the moment that module resolves. Geometry is
   * built once; only these references move.
   *
   * The preview ships only the pose SEGMENTS its window touches (donnaPose1, jackPose3, roryPose0),
   * so segments are discovered from the tracks that exist rather than assumed from the presence
   * table, and a time with no shipped segment falls through to the same hold rule an outage uses.
   */
  function bindTracks(data) {
    D = data;
    const ev = {};
    for (const row of data.events || []) ev[row.id] = row;
    evGoal1 = ev[EV_GOAL_1] || null;
    evGoal2 = ev[EV_GOAL_2] || null;

    for (const bot of bots) {
      const k = bot.key;
      bot.presence = data.presence[k];
      bot.jointsSpec = data.meta.tracks[`${k}Joints`];
      bot.jointsCols = data.tracks[`${k}Joints`];
      bot.quatSpec = data.meta.tracks[`${k}TorsoQuaternion`];
      bot.quatCols = data.tracks[`${k}TorsoQuaternion`];
      bot.stateT = data.tracks[`${k}RobotState`].t10ms;
      bot.stateV = data.tracks[`${k}RobotState`].state;
      bot.hudCols = data.tracks[`${k}Hud`];

      const segs = [];
      for (const name of Object.keys(data.meta.tracks)) {
        const m = new RegExp(`^${k}Pose(\\d+)$`).exec(name);
        if (!m) continue;
        const spec = data.meta.tracks[name];
        const cols = data.tracks[name];
        const base = spec.timing.segmentStart10ms;
        // absolute mission ticks, so a hold/interpolate decision never has to remember a base
        const ticks = new Float64Array(cols.t10ms.length);
        for (let i = 0; i < ticks.length; i++) ticks[i] = base + cols.t10ms[i];
        segs.push({
          index: Number(m[1]),
          ticks,
          x: cols.xM,
          y: cols.yM,
          yaw: cols.yawRad,
          startTick: ticks[0],
          endTick: ticks[ticks.length - 1],
        });
      }
      segs.sort((a, b) => a.startTick - b.startTick);
      bot.poseSegs = segs;
    }
    lastPoseT = null;
  }

  // ------------------------------------------------------------------ lazy build

  function build(data) {
    isProxy = proxyMesh(data);
    buildField();
    const lib = buildMeshLibrary(data.mesh, data.meta.mesh.visualInstances.buckets);
    const contactTex = keep(contactTexture(THREE));
    bots = ROBOTS.map((spec) => buildRobot(spec, lib, contactTex));
    ball = buildBall();
    bindTracks(data);

    built = true;
    root.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    // Pose once at the frozen hero moment so cameraFocus() has an answer before the first update,
    // which is what the picker card asks for when it stages this mission.
    pose(clampT(HERO_T));
    heroFocus = readFocus(heroOut);
    if (highlight) applyHighlight();
  }

  const clampT = (t) => {
    const w = (D && D.meta && D.meta.window) || [0, 250];
    return t < w[0] ? w[0] : t > w[1] ? w[1] : t;
  };

  // ------------------------------------------------------------------ sampling

  /** Fractional index into a uniform track, clamped to its ends. */
  function uniformIndex(spec, t) {
    const x = (t * 1000 - spec.timing.startMs) / spec.timing.stepMs;
    return x < 0 ? 0 : x > spec.count - 1 ? spec.count - 1 : x;
  }

  /**
   * Joint angles at t: this robot's own grid (Donna 25 Hz, teammates 10 Hz), linearly interpolated.
   *
   * Linear rather than cubic. A joint column is a recorded joint-state position MEASUREMENT; a
   * Catmull-Rom through it overshoots at every stride reversal, which on a knee is a bend the
   * machine never made. That matters more at the teammates' 10 Hz, not less.
   *
   * Joints replay through an outage. During Jack's three falls his localization drops but his
   * `/joint_states` keeps streaming, so the recorded fall animation is real data and plays; only
   * the ROOT pose is held. See poseField().
   */
  function poseJoints(bot, t) {
    const spec = bot.jointsSpec;
    const x = uniformIndex(spec, t);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, spec.count - 1);
    const s = x - i0;
    const cols = bot.jointsCols;
    for (let k = 0; k < bot.joints.length; k++) {
      const j = bot.joints[k];
      const col = cols[j.name];
      if (!col) continue;
      const q = col[i0] + (col[i1] - col[i0]) * s;
      j.q = q;
      qTmp.setFromAxisAngle(j.axis, q);
      j.node.quaternion.copy(j.qFixed).multiply(qTmp);
    }
  }

  /** Torso attitude at t: the yaw-free tilt quaternion, slerped on the shared 20 Hz grid. */
  function poseTorso(bot, t) {
    const spec = bot.quatSpec;
    const x = uniformIndex(spec, t);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, spec.count - 1);
    const s = x - i0;
    const c = bot.quatCols;
    qA.set(c.qx[i0], c.qy[i0], c.qz[i0], c.qw[i0]).normalize();
    qB.set(c.qx[i1], c.qy[i1], c.qz[i1], c.qw[i1]).normalize();
    qA.slerp(qB, s);
    bot.torso.quaternion.copy(qA);
  }

  /** The presence row covering t. The table is a continuous partition of the module window. */
  function presenceAt(bot, t) {
    const segs = bot.presence;
    let out = segs[0];
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].startT) out = segs[i];
      else break;
    }
    return out;
  }

  /**
   * Field pose at t: interpolate INSIDE a live segment, HOLD across everything else.
   *
   * Each pose track is one live localization segment. Inside a segment the estimate is continuous
   * and is interpolated; across a boundary it is NOT, because the filter teleported (Donna moved
   * ~1.98 m while her pose stream was dark for the whole of her penalty), and a replay that lerped
   * across the jump would draw a smooth slide the robot never walked. So the pose holds at the last
   * sample of the old segment and jumps when the new one starts, which is the frozen consumer rule
   * in FORMAT-V2 ("Consumers may interpolate only inside one pose segment").
   *
   * A HOLD outage - Jack's falls - lands in exactly the same branch: no segment contains t, so the
   * root freezes at the last observed sample while the joints and the IMU keep replaying. That is
   * the disclosed behaviour, not an accident of the lookup, and the HUD chip says "fallen" for
   * precisely that interval.
   */
  function poseField(bot, t) {
    const tick = t * 100;
    const segs = bot.poseSegs;
    let hit = null;
    let prev = null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (tick >= s.startTick && tick <= s.endTick) {
        hit = s;
        break;
      }
      if (s.endTick < tick) prev = s;
    }
    let x;
    let y;
    let yaw;
    if (hit) {
      const i = Math.max(0, holdIndex(hit.ticks, tick));
      const j = Math.min(i + 1, hit.ticks.length - 1);
      x = hit.x[i];
      y = hit.y[i];
      yaw = hit.yaw[i];
      if (j !== i) {
        const span = hit.ticks[j] - hit.ticks[i];
        const s = span > 0 ? clamp01((tick - hit.ticks[i]) / span) : 0;
        x += (hit.x[j] - x) * s;
        y += (hit.y[j] - y) * s;
        yaw = lerpRad(yaw, hit.yaw[j], s);
      }
    } else {
      // outage, or a preview module that ships only the segments its window touches
      const s = prev || segs[0];
      const i = prev ? s.ticks.length - 1 : 0;
      x = s.x[i];
      y = s.y[i];
      yaw = s.yaw[i];
    }
    bot.x = x;
    bot.y = y;
    bot.group.position.set(x, y, 0);
    bot.group.rotation.set(0, 0, yaw);
  }

  /**
   * Rest a body on the pitch.
   *
   * The recordings carry joints, torso attitude and a field (x, y, yaw). They do NOT carry the
   * torso's height off the ground - no channel in these logs measures it - so the height is DERIVED
   * here by dropping the assembled body until its lowest contact candidate touches z = 0. That is a
   * rendering choice, not recorded data and not physics: nothing here integrates a contact force,
   * and the robot's pose is whatever its servos actually reported.
   *
   * The candidates are the real CAD's extreme vertices per driven bucket (see buildMeshLibrary), so
   * a fallen robot rests on whatever part of it is actually lowest rather than hovering by the
   * length of its own legs.
   */
  function groundOffset(bot) {
    bot.group.position.z = 0;
    // Ancestors FIRST: the frame map lives on the root, and reading a world height before the root
    // has a world matrix would measure the ROS lateral axis instead of the vertical one. Then the
    // rig, downward. Both calls are surgical rather than a whole-scene update, and neither
    // allocates.
    root.updateWorldMatrix(true, false);
    bot.group.updateWorldMatrix(false, true);
    let minY = Infinity;
    const pts = bot.contactPts;
    for (let k = 0; k < pts.length; k++) {
      const c = pts[k];
      vTmp.set(c.x, c.y, c.z).applyMatrix4(c.node.matrixWorld);
      if (vTmp.y < minY) minY = vTmp.y;
    }
    // world +y is ROS +z through the root's frame map, and the root is a pure rotation, so the lift
    // measured in world height applies unchanged as a local z translation
    if (Number.isFinite(minY)) bot.group.position.z = -minY;
    bot.group.updateWorldMatrix(false, true);
  }

  /**
   * The ball at t, from Donna's filtered map-frame estimate.
   *
   * `donnaBallField` is already in the map (field) frame, so there is no pose to transform through
   * and none is applied - the FORMAT-V2 track is the validated estimate itself. Two masks:
   *
   *   * `ballSeen`. A masked tick carries filler ZEROS, so interpolating into one would walk the
   *     ball to the centre spot and holding the last seen one would keep drawing an estimate the
   *     filter did not have. Either bracketing tick clear means hidden, full stop.
   *   * Donna's presence. The track deliberately does NOT require her localization to be valid, so
   *     it still carries estimates published while she was off the field serving her penalty. Those
   *     are not observations of play, and this replay does not draw them: no Donna on the pitch,
   *     no ball marker.
   */
  function poseBall(t, donnaVisible) {
    const spec = D.meta.tracks.donnaBallField;
    const x = uniformIndex(spec, t);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, spec.count - 1);
    const s = x - i0;
    const b = D.tracks.donnaBallField;
    if (!donnaVisible || !(b.ballSeen[i0] > 0.5) || !(b.ballSeen[i1] > 0.5)) {
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
    let donnaVisible = false;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const seg = presenceAt(bot, t);
      bot.mode = seg.renderMode;
      const shown = seg.renderMode !== 'HIDDEN';
      bot.group.visible = shown;
      bot.contact.visible = shown;
      bot.ring.visible = shown;
      if (bot.key === 'donna') donnaVisible = shown;
      if (!shown) {
        if (bot.halo.visible) bot.halo.visible = false;
        continue;
      }
      poseJoints(bot, t);
      poseTorso(bot, t);
      poseField(bot, t);
      groundOffset(bot);
      bot.contact.position.set(bot.x, bot.y, Z_CONTACT);
      bot.ring.position.set(bot.x, bot.y, Z_RING);
      if (highlightHits(bot)) {
        bot.halo.visible = true;
        bot.halo.position.set(bot.x, bot.y, Z_HALO);
      } else {
        bot.halo.visible = false;
      }
    }
    poseBall(t, donnaVisible);
  }

  /**
   * Where the shot should sit: the centroid of the torsos that are actually ON the pitch, in THREE
   * world coordinates. Three robots spread over five metres have no single subject, and a follow
   * that locked onto one of them would walk the other two out of frame. A robot in a HIDDEN outage
   * does not vote, which is why the shot recentres when Donna is carried off for her penalty rather
   * than holding a gap where she is not.
   */
  function readFocus(out) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < bots.length; i++) {
      if (!bots[i].group.visible) continue;
      bots[i].torso.getWorldPosition(vTmp);
      sx += vTmp.x;
      sy += vTmp.y;
      sz += vTmp.z;
      n++;
    }
    if (!n) {
      out.x = 0;
      out.y = 0.4;
      out.z = 0;
      return out;
    }
    out.x = sx / n;
    out.y = sy / n;
    out.z = sz / n;
    return out;
  }

  // ------------------------------------------------------------------ per-frame

  function update(tSec, data) {
    if (!built) {
      if (
        !data ||
        !data.tracks ||
        !data.tracks.donnaJoints ||
        !data.meta ||
        !data.meta.tracks ||
        !data.mesh ||
        !data.presence ||
        !data.events
      ) {
        return;
      }
      build(data);
    } else if (data && data !== D && data.tracks && data.tracks.donnaJoints && data.presence) {
      // the picker card staged this off the preview module and the full match has now resolved
      bindTracks(data);
    }
    const t = clampT(Number.isFinite(tSec) ? tSec : 0);
    pose(t);
    stepTags();
    lastFocus = readFocus(focusOut);
    if (highlight) driveHighlight(t);
  }

  /**
   * Carry the three name tags to the opacity the current step wants them at.
   *
   * ASYMMETRIC ON PURPOSE. Standing down is instant, because the anatomy step arrives as a cut to a
   * half-metre stand-off and easing out means a quarter second of a giant label over a card fading
   * in under it. Coming back is eased: it comes back on the replay, where a tag snapping to full
   * opacity on the frame the overlay closes reads as a glitch rather than as a label.
   */
  function stepTags() {
    const now = nowMs();
    const want = tagsStandDownOnAnatomy && now - anchorReadAt < ANCHOR_LIVE_MS ? 0 : 1;
    if (want < tagFade) tagFade = want;
    else if (want > tagFade) {
      // Clamped, so a backgrounded tab resuming after seconds of no frames eases in over the
      // authored time instead of snapping.
      const dt = tagFadeAt ? Math.min(now - tagFadeAt, TAG_FADE_MS) : 16;
      tagFade = Math.min(want, tagFade + dt / TAG_FADE_MS);
    }
    tagFadeAt = now;
    for (let i = 0; i < bots.length; i++) {
      const tag = bots[i].tag;
      tag.material.opacity = tagFade;
      // Off the render list at zero rather than drawn transparent, so a stood-down tag cannot put a
      // depth-sorted pass over the shot it is standing down for.
      tag.visible = tagFade > 0.02;
    }
  }

  function driveHighlight(t) {
    const pulse = 0.3 + Math.abs(Math.sin(t * 4.2)) * 0.55;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (!highlightHits(bot)) continue;
      bot.halo.material.opacity = pulse * 0.8;
      bot.mats.light.emissiveIntensity = pulse * 0.45;
      bot.mats.dark.emissiveIntensity = pulse * 0.45;
    }
  }

  // ------------------------------------------------------------------ HUD contract

  /**
   * The referee strip at t, version-keyed so the viewer only touches the DOM on a transition.
   *
   * WHERE EACH FIELD COMES FROM, because the sources are not interchangeable:
   *   * the NUMBERS and the MATCH STATE - clock, both scores, PLAYING/FINISHED - are read off
   *     `donnaHud`, the 2 Hz zero-order-held grid carrying Donna's master gamestate. One source, so
   *     the strip and the chart can never disagree about the score.
   *   * each ROBOT CHIP's `penalized` flag is read off THAT robot's own HUD track, never inferred
   *     from a teammate's array, which is the frozen rule in FORMAT-V2 ("Penalised must be
   *     independently read for each robot").
   *   * each chip's `state` is that robot's own recorded `RobotControlState`, zero-order held, and
   *     its `tone` is that robot's own presence render mode.
   *   * the GOAL CALLOUT comes off the frozen event ledger, because it is an instant and the 2 Hz
   *     grid is a grid: the note opens exactly at the recorded message time while the score digit
   *     turns over on the next tick that saw it. That half-second is the resampling grid, not a
   *     disagreement, and it is here in writing rather than tuned away.
   *
   * WHY THE CHIPS EXIST. Three robots replayed from three independent logs are three different
   * presence stories at any instant, and the strip's single `state.note` cannot carry three. A
   * viewer that does not know the chip ABI drops both keys and renders the strip it always did.
   */
  const CHIP_NOTE = {
    'penalty-outage': 'penalized',
    'pre-first-fix': 'no fix',
    'fall-outage': 'fallen',
  };
  let hudHudI = -2;
  let hudNote = null;
  let hudChipKey = null;
  function hudState(tSec) {
    if (!built) return null;
    const t = clampT(Number.isFinite(tSec) ? tSec : 0);
    const spec = D.meta.tracks.donnaHud;
    // FLOOR, not nearest: the HUD grid is zero-order held, so the strip shows the last recorded
    // tick at or before t. Rounding to the nearest would show a score half a second before the
    // recording knew it.
    const i = Math.floor(uniformIndex(spec, t) + 1e-6);
    const g = D.tracks.donnaHud;

    const label = D.meta.codeTables.gameState[Math.round(g.gameState[i])] || 'UNKNOWN';
    const tone = label === 'PLAYING' ? 'live' : label === 'READY' || label === 'SET' ? 'prep' : 'stop';

    let note = '';
    if (evGoal2 && t >= evGoal2.t && t < evGoal2.t + GOAL_NOTE_S) note = 'GOAL 6-0';
    else if (evGoal1 && t >= evGoal1.t && t < evGoal1.t + GOAL_NOTE_S) note = 'GOAL 5-0';

    // the chips move on presence class, robot state and the per-robot penalized flag, none of which
    // are on the 2 Hz grid, so they get their own short-circuit key
    let chipKey = '';
    for (let k = 0; k < bots.length; k++) {
      const bot = bots[k];
      const seg = presenceAt(bot, t);
      const si = Math.max(0, holdIndex(bot.stateT, t * 100));
      const stateName = D.meta.codeTables.robotState[Math.round(bot.stateV[si])] || 'UNKNOWN';
      const penalized = bot.hudCols.penalized[i] > 0.5;
      // The presence class is the honest reason a body is or is not on the pitch, so it wins the
      // chip note; the penalized flag is the fallback for a robot who is penalized while her own
      // log still has her localized. Rory before her first map fix is BOTH (she is penalized until
      // she re-enters at 28.07, and has no map pose until 28.27), and says so.
      let chipNote = CHIP_NOTE[seg.className] || '';
      if (seg.className === 'pre-first-fix' && penalized) chipNote = 'penalized, no fix';
      else if (!chipNote && penalized) chipNote = 'penalized';
      const chip = hud.chips[k];
      chip.name = bot.label;
      chip.state = stateName;
      chip.note = chipNote;
      chip.tone = seg.renderMode === 'LIVE' ? 'live' : seg.renderMode === 'HOLD' ? 'hold' : 'hidden';
      chipKey += `|${chip.name}/${chip.state}/${chip.note}/${chip.tone}`;
    }

    // Short-circuit on everything a rendered field can move with. Without it this rebuilds a dozen
    // strings sixty times a second for a strip that changes a handful of times a minute.
    if (i === hudHudI && note === hudNote && chipKey === hudChipKey) return hud;
    hudHudI = i;
    hudNote = note;
    hudChipKey = chipKey;

    const own = Math.round(g.ownScore[i]);
    const rival = Math.round(g.rivalScore[i]);
    hud.teams[0].score = own;
    hud.teams[1].score = rival;
    hud.clock = clockText(g.secondsRemaining[i]);
    hud.state.label = label;
    hud.state.tone = tone;
    hud.state.note = note;

    // EVERY rendered field is in the key, the two constant names, the dot colours and all three
    // chips included. A field that moved while the version did not would sit stale behind the
    // viewer's short-circuit.
    hud.version =
      hud.clock +
      '|' + own + ':' + rival +
      '|' + label +
      '|' + tone +
      '|' + note +
      '|' + hud.teams[0].name + '/' + hud.teams[0].color +
      '|' + hud.teams[1].name + '/' + hud.teams[1].color +
      chipKey;
    return hud;
  }

  // ------------------------------------------------------------------ camera + highlight

  /**
   * With an argument: where the robots are at that moment. Without one, this is the picker card
   * asking where they ARE at the moment they were just posed at, so it answers with the last
   * update()'s focus and falls back to the frozen hero moment, which has all three present, upright
   * and un-penalized.
   */
  function cameraFocus(tSec) {
    if (!built) return null;
    if (Number.isFinite(tSec)) {
      pose(clampT(tSec));
      return readFocus(focusOut);
    }
    return lastFocus || heroFocus;
  }

  // Three robots on a 9 x 6 m pitch, walking at well under 0.5 m/s, followed on a CENTROID that
  // legitimately jumps when a robot enters or leaves a presence segment: a softer spring than
  // battle's, and a snap threshold just above the largest honest frame-to-frame move so both a
  // localization jump and a presence change cut instead of whipping.
  const followTuning = { omega: 2.2, lead: 0.15, snap: 1.2 };

  /** Does the current highlight select this robot? */
  function highlightHits(bot) {
    if (!highlight) return false;
    return highlight === 'team' || highlight === bot.key;
  }

  function applyHighlight() {
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const on = highlightHits(bot);
      bot.mats.light.emissive.setHex(on ? ALERT : 0x000000);
      bot.mats.dark.emissive.setHex(on ? ALERT : 0x000000);
      bot.mats.light.emissiveIntensity = on ? 0.35 : 0;
      bot.mats.dark.emissiveIntensity = on ? 0.35 : 0;
      bot.halo.visible = on && bot.group.visible;
      bot.halo.material.opacity = on ? 0.4 : 0;
      if (bot.halo.visible) bot.halo.position.set(bot.x, bot.y, Z_HALO);
    }
  }

  /**
   * `team` is what a finding about the match points at, and `donna` / `jack` / `rory` are what a
   * finding about ONE robot points at - Jack's three falls are his, Donna's penalty is hers. That
   * is the honest granularity: no finding in this mission belongs to one limb. Anything else
   * clears, which is also how the four legacy part ids (`body`, `head`, `arms`, `legs`) are
   * folded onto the whole team rather than silently selecting nothing.
   */
  function setHighlight(partId) {
    if (partId === 'team' || partId === 'donna' || partId === 'jack' || partId === 'rory') highlight = partId;
    else if (partId && /^(body|head|arms|legs)$/.test(partId)) highlight = 'team';
    else highlight = null;
    if (built) applyHighlight();
  }

  // ------------------------------------------------------------------ anatomy anchors
  //
  // Four world points on DONNA for the connect flow's anatomy overlay. Every one is read off a node
  // this scene already poses, so a label stays on its part while the camera orbits, while she
  // walks, and while a body leans: nothing here is a fixed point on the pitch.
  //
  // The two torso points are offsets in the TORSO LINK's own URDF frame, whose +z runs up the
  // spine (both hip yaw joints sit at z = 0 and the neck joint at z = 0.2345), so they carry the
  // recorded torso attitude with them. The leg point is the midpoint of the two nodes the left leg
  // chain hangs off, the hip pitch origin and the knee origin, which is a real segment of the rig
  // rather than a guessed spot on a mesh. No anchor claims a part the CAD does not have.
  //
  // WHEN THE BODY IS NOT THERE. Donna is HIDDEN for her off-field penalty and pose() leaves a
  // hidden body's transforms untouched, so these closures keep answering with her last observed
  // pose instead of throwing or inventing a position for a robot nobody was tracking. Before the
  // first build and after dispose() they answer with the zero vector for the same reason: an
  // anchor is a rendering hint, and a missing one must not take the screen down with it. The
  // anatomy step poses the scene at the frozen hero moment (187.6 s), where she is on the pitch.
  //
  // A FIFTH KEY THAT IS NOT A CARD. `bodyForward` is not a part and the anatomy overlay never asks
  // for it: it exists so a directed tour can resolve WHICH WAY DONNA IS FACING. The viewer builds
  // the robot's frame from two anchors and drops the vertical component of their difference, and no
  // pair of the four card anchors survives that. compute -> imu is the spine, 0.02-0.04 m of
  // horizontal residue whose bearing swings through 280 degrees across 187-190 s; compute -> servos
  // is a LEG, which the gait swings through 60 degrees of the same passage; head is on two live
  // joints that pan +-1.5 rad. This point is the torso link's own +x axis (ROS FLU: x forward) a
  // fixed 0.2 m out at the compute anchor's height, so the pair differs by nothing but that axis
  // and reads Donna's recorded heading directly off the node the replay poses - -32.9 degrees in
  // the scene frame at the hero instant, which is her recorded yaw. Additive: a viewer that does
  // not know the key is unaffected, and no card can ever point at it.
  const TORSO_IMU_Z = 0.15; // upper torso, below the shoulder joints at 0.2035
  const TORSO_COMPUTE_Z = 0.04; // lower torso, just above the hip joints at 0
  const TORSO_FWD_X = 0.2; // long enough that joint noise cannot rotate the bearing
  // WHY THE HEAD ANCHOR IS NOT THE HEADTILT JOINT ORIGIN. That origin is the tilt PIVOT: it sits on
  // the neck bracket, below and behind the housing, and a leader line drawn to it lands on the servo
  // horn between the shoulders. On the anatomy step that reads as a label pointing at the top of the
  // torso rather than at the head, which is the one thing the card is about. These three numbers are
  // the centre of the head link's own merged CAD, measured in the HeadTilt node's local frame off
  // the built rig: the geometry spans x -0.062..0.065, y -0.025..0.105, z -0.0535..0.0195, so the
  // centre is 0.040 m up the link and 0.017 m back. It is a point INSIDE the housing that carries
  // the cameras, it rides both head joints exactly as the pivot did, and it claims no part the CAD
  // does not have. Every consumer is a rendering hint (the overlay's leader, the tour's aim point),
  // so a 43 mm move costs nothing anywhere else.
  const HEAD_CENTRE = [0, 0.04, -0.017];
  const anchorOut = {
    head: new THREE.Vector3(),
    imu: new THREE.Vector3(),
    servos: new THREE.Vector3(),
    compute: new THREE.Vector3(),
    bodyForward: new THREE.Vector3(),
  };
  const vAnchor = new THREE.Vector3();
  let anchorMap = null;
  let partMeshMap = null;

  /** Donna's runtime row, or null while nothing is built. */
  function donnaBot() {
    if (!built || !bots) return null;
    for (let i = 0; i < bots.length; i++) if (bots[i].key === 'donna') return bots[i];
    return null;
  }

  /** The rig node a named joint drives, which is that joint's CHILD link. */
  function jointNode(bot, jointName) {
    for (let i = 0; i < bot.joints.length; i++) {
      if (bot.joints[i].name === jointName) return bot.joints[i].node;
    }
    return null;
  }

  /**
   * A point at a local offset in `node`'s frame, in world coordinates, written into `out`.
   *
   * Ancestors are refreshed first because an anchor can be read on a frame where nothing moved,
   * and a stale world matrix would answer with the previous pose's position.
   */
  function nodePoint(node, out, x, y, z) {
    node.updateWorldMatrix(true, false);
    return out.set(x, y, z).applyMatrix4(node.matrixWorld);
  }

  /**
   * The anatomy anchor map: part id to a closure reading that part's world position from the
   * CURRENT pose. Additive and optional - a viewer that does not know this ABI is unaffected.
   *
   * @returns {Record<string, () => import('three').Vector3>}
   */
  function anchors() {
    if (anchorMap) return anchorMap;
    anchorMap = {
      head: () => {
        const bot = donnaBot();
        const node = bot && jointNode(bot, 'HeadTilt');
        return node
          ? nodePoint(node, anchorOut.head, HEAD_CENTRE[0], HEAD_CENTRE[1], HEAD_CENTRE[2])
          : anchorOut.head;
      },
      imu: () => {
        const bot = donnaBot();
        return bot ? nodePoint(bot.torso, anchorOut.imu, 0, 0, TORSO_IMU_Z) : anchorOut.imu;
      },
      servos: () => {
        const bot = donnaBot();
        const upper = bot && jointNode(bot, 'LHipPitch');
        const knee = bot && jointNode(bot, 'LKnee');
        if (!upper || !knee) return anchorOut.servos;
        nodePoint(upper, anchorOut.servos, 0, 0, 0);
        nodePoint(knee, vAnchor, 0, 0, 0);
        return anchorOut.servos.lerp(vAnchor, 0.5);
      },
      compute: () => {
        const bot = donnaBot();
        return bot ? nodePoint(bot.torso, anchorOut.compute, 0, 0, TORSO_COMPUTE_Z) : anchorOut.compute;
      },
      bodyForward: () => {
        const bot = donnaBot();
        return bot
          ? nodePoint(bot.torso, anchorOut.bodyForward, TORSO_FWD_X, 0, TORSO_COMPUTE_Z)
          : anchorOut.bodyForward;
      },
    };
    // Wrapped ONCE, here, to stamp the read: a leader or a camera beat asking where a part is, this
    // frame, is this file's only evidence that an anatomy overlay is live on this instance, and
    // stepTags() stands the name tags down on it. Wrapping here keeps the five readers above about
    // geometry and costs one assignment per call, allocating nothing on any frame. Each wrapper
    // returns the same Vector3 its closure owns, so the aliasing contract callers live under holds.
    for (const key of Object.keys(anchorMap)) {
      const read = anchorMap[key];
      anchorMap[key] = () => {
        anchorReadAt = nowMs();
        return read();
      };
    }
    return anchorMap;
  }

  /**
   * The anatomy tour's highlight channel (`sceneApi.partMeshes()`, documented in viewer.js): the
   * meshes on DONNA each of her four cards is about, so the tour can light the live one while the
   * camera holds her whole body in frame. Head and legs are merged CAD buckets - the head link with
   * its pan bracket, and both legs' thigh and shank, which is what the leg servos drive and where
   * the CAD's own Dynamixel housings are; the other two are the boxes `buildRobot()` adds.
   *
   * @returns {Record<string, import('three').Mesh[]>}
   */
  function partMeshes() {
    const bot = donnaBot();
    if (!bot) return {};
    if (partMeshMap) return partMeshMap;
    const pick = (...buckets) =>
      buckets.flatMap((b) =>
        ['light', 'dark'].map((cls) => bot.group.getObjectByName(`${bot.key}:${b}:${cls}`)).filter(Boolean),
      );
    partMeshMap = {
      head: pick('HeadTilt', 'HeadPan'),
      imu: [bot.modules[0]],
      servos: pick('LHipPitch', 'LKnee', 'RHipPitch', 'RKnee'),
      compute: [bot.modules[1]],
    };
    return partMeshMap;
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
    bots = null;
    ball = null;
    evGoal1 = null;
    evGoal2 = null;
    lastFocus = null;
    heroFocus = null;
    highlight = null;
    hudHudI = -2;
    hudNote = null;
    hudChipKey = null;
    lastPoseT = null;
    partMeshMap = null;
    built = false;
    isProxy = false;
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
    anchors,
    partMeshes,
    // The viewer's default rig is wrong for an 11 x 8 m pitch with its own turf: an 80 m ground
    // plane and two 60 m grids would sit under the field, and a 1024^2 shadow map over an 18 m
    // frustum is ~18 mm/texel, which on a 0.09 m foot is a smear. Grounding is the baked contact
    // patch instead, and every mesh here sets castShadow = false. `env` IS asked for, which v1 did
    // not need: the CAD's motor housings and milled brackets carry real metalness, and with no IBL
    // to reflect every one of them collapses to flat grey.
    rendering: {
      ground: false,
      grids: false,
      shadow: false,
      env: true,
      fog: { color: 0x0e1114, near: 14, far: 48 },
    },
  };
}
