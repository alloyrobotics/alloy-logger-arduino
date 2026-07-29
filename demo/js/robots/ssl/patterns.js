// patterns.js - the sixteen standard RoboCup SSL vision patterns, as printed art.
//
// SOURCE OF TRUTH
// ---------------
// RoboCup-SSL/ssl-vision, `patterns/teams/standard2010_16.png` (the 16-pattern sheet;
// the sibling `standard2010.png` carries only the first twelve). Fetched from
// https://raw.githubusercontent.com/RoboCup-SSL/ssl-vision/master/patterns/teams/standard2010_16.png
// sha256 55fc6b0d96cd620410e06243411272da37b9b5866bb1514a25a1e778c1a4d5f4
//
// The table below was DERIVED, not typed from memory: the 800x800 sheet is a 4x4 grid of
// 200x200 cells with `id = row * 4 + col`; each cell was connected-component labelled for
// pure magenta (#ff00ff) and pure green (#00ff00) blobs, their centroids taken relative to
// the blue centre blob, and each blob assigned to a quadrant. All sixteen signatures come
// out distinct, which is the property the league relies on.
//
// The sheet is drawn at one SVG user unit per millimetre, so the same pass also yields the
// geometry (cross-checked against the ellipse transforms in `standard2010_16.svg`, and
// against the 2026 rulebook's "pattern within r=85 mm, front-cut at 55 mm"):
//
//   centre dot diameter   48.7 px measured  -> 50 mm nominal (antialiased edges are excluded
//   outer dot diameter    38.8 px measured  -> 40 mm nominal  by the exact-colour test, which
//   pattern disc radius   84.7 px measured  -> 85 mm nominal  costs ~0.6 px per side)
//   pattern front cut     55.3 px measured  -> 55 mm nominal
//   front dot centres     (+35.3, +/-54.8) mm   in robot frame: +x forward, +y left
//   back  dot centres     (-54.8, +/-35.0) mm
//
// The centre dot is the REFEREE-ASSIGNED team colour (blue or yellow) and is never
// recoloured to a display palette. The four outer dots encode the robot id.

/** Outer-dot colours in slot order [front-left, front-right, back-right, back-left]. */
export const PATTERN_DOTS = Object.freeze({
  0: ['pink', 'pink', 'pink', 'green'],
  1: ['green', 'pink', 'pink', 'green'],
  2: ['green', 'green', 'pink', 'green'],
  3: ['pink', 'green', 'pink', 'green'],
  4: ['pink', 'pink', 'green', 'pink'],
  5: ['green', 'pink', 'green', 'pink'],
  6: ['green', 'green', 'green', 'pink'],
  7: ['pink', 'green', 'green', 'pink'],
  8: ['green', 'green', 'green', 'green'],
  9: ['pink', 'pink', 'pink', 'pink'],
  10: ['pink', 'pink', 'green', 'green'],
  11: ['green', 'green', 'pink', 'pink'],
  12: ['green', 'pink', 'green', 'green'],
  13: ['green', 'pink', 'pink', 'pink'],
  14: ['pink', 'green', 'green', 'green'],
  15: ['pink', 'green', 'pink', 'pink'],
});

/** Slot centres in metres, robot frame: x forward, y left. Same order as PATTERN_DOTS. */
export const DOT_SLOTS_M = Object.freeze([
  { x: 0.0353, y: 0.0548 }, // front-left
  { x: 0.0353, y: -0.0548 }, // front-right
  { x: -0.0548, y: -0.0351 }, // back-right
  { x: -0.0548, y: 0.0351 }, // back-left
]);

export const DOT_RADIUS_M = 0.02;
export const CENTRE_RADIUS_M = 0.025;
export const PATTERN_RADIUS_M = 0.085;
export const PATTERN_FRONT_CUT_M = 0.055;

/** Exactly the two blob colours ssl-vision ships in the sheet. */
export const DOT_COLOUR = Object.freeze({ pink: '#ff00ff', green: '#00ff00' });

/** Referee colours. NOT the display palette - a team rename never touches these. */
export const CENTRE_COLOUR = Object.freeze({ yellow: '#ffe600', blue: '#0033ff' });

/** Matte tops, per the rules: robot top black/dark grey, printed label a touch darker. */
export const TOP_PLATE_COLOUR = '#17181a';
export const PRINT_COLOUR = '#0a0a0b';

/**
 * Paint one robot's top plate: the robot's own top surface, the printed pattern disc on it,
 * the referee-colour centre dot and the four id dots.
 *
 * The canvas is square and covers the full 2*bodyRadius footprint so it can be mapped onto a
 * plain quad with no UV gymnastics. Robot frame -> canvas: forward is +x (right), left is -y
 * (up), which is what the caller's rotated PlaneGeometry expects.
 *
 * @param {Document} doc
 * @param {number} id 0..15
 * @param {'yellow'|'blue'} refereeColor
 * @param {number} bodyRadius m
 * @param {number} bodyFrontCut m, distance from centre to the flat dribbler face
 * @param {number} px canvas edge in pixels
 * @returns {HTMLCanvasElement}
 */
export function paintPattern(doc, id, refereeColor, bodyRadius, bodyFrontCut, px) {
  const c = doc.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d');
  const k = px / (2 * bodyRadius); // px per metre
  const X = (mx) => (mx + bodyRadius) * k; // forward -> canvas x
  const Y = (my) => (bodyRadius - my) * k; // left    -> canvas y

  // The robot's top surface: a disc of bodyRadius with the dribbler face cut flat off the front.
  const cutDisc = (r, cut, fill) => {
    g.save();
    g.beginPath();
    g.rect(0, 0, X(cut), px); // keep everything behind the chord
    g.clip();
    g.beginPath();
    g.arc(X(0), Y(0), r * k, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.restore();
  };

  g.clearRect(0, 0, px, px);
  cutDisc(bodyRadius, bodyFrontCut, TOP_PLATE_COLOUR);
  cutDisc(PATTERN_RADIUS_M, PATTERN_FRONT_CUT_M, PRINT_COLOUR);

  const dot = (mx, my, r, fill) => {
    g.beginPath();
    g.arc(X(mx), Y(my), r * k, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };

  dot(0, 0, CENTRE_RADIUS_M, CENTRE_COLOUR[refereeColor] || CENTRE_COLOUR.blue);
  const slots = PATTERN_DOTS[id];
  if (slots) {
    for (let i = 0; i < 4; i++) {
      dot(DOT_SLOTS_M[i].x, DOT_SLOTS_M[i].y, DOT_RADIUS_M, DOT_COLOUR[slots[i]]);
    }
  }
  return c;
}
