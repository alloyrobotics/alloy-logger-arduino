// experience.test.mjs - the four active mission experience blocks resolve against live defs and scenes.

import * as THREE from '../../../vendor/three.module.js';
import { ROBOTS_BY_ID } from '../index.js';
import { applyRoleOpeners as applySslSideModule } from '../ssl/role-openers.js';
import { applyExperience as applyDonnaExperience } from '../donna/experience.js';

const MISSIONS = ['arm6', 'drone', 'ssl', 'donna'];

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const section = (name) => console.log(`\n${name}`);

const ssl = ROBOTS_BY_ID.get('ssl');
const donna = ROBOTS_BY_ID.get('donna');
applySslSideModule(ssl);
applyDonnaExperience(donna);

function overlaps(a, b) {
  return Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
}

for (const mission of MISSIONS) {
  const def = ROBOTS_BY_ID.get(mission);
  const exp = def && def.experience;
  section(mission);

  ok(!!def, `${mission} resolves from ROBOTS_BY_ID`);
  ok(!!exp, `${mission} has an experience block`);
  if (!def || !exp) continue;

  const parts = exp.anatomy && exp.anatomy.parts;
  ok(Array.isArray(parts) && parts.length === 4, `${mission} has exactly four anatomy parts`);
  ok(new Set((parts || []).map((part) => part.id)).size === 4, `${mission} anatomy ids are unique`);
  ok(
    (parts || []).every((part) =>
      typeof part.id === 'string' && part.id.trim() &&
      typeof part.anchor === 'string' && part.anchor.trim() &&
      typeof part.label === 'string' && part.label.trim() &&
      typeof part.description === 'string' && part.description.trim()),
    `${mission} anatomy parts carry id, anchor, label and description`,
  );

  const mount = new THREE.Group();
  let scene = null;
  let anchors = null;
  let sceneError = null;
  try {
    scene = def.buildScene(THREE, mount);
    anchors = scene && typeof scene.anchors === 'function' ? scene.anchors() : null;
  } catch (err) {
    sceneError = err;
  }
  ok(!sceneError, `${mission} live buildScene() exposes its additive anchor API (${sceneError ? sceneError.message : 'ok'})`);
  ok(!!anchors && typeof anchors === 'object', `${mission} scene returns an anchor map`);
  for (const part of parts || []) {
    const resolve = anchors && anchors[part.anchor];
    ok(typeof resolve === 'function', `${mission}/${part.id} anchor "${part.anchor}" resolves`);
    if (typeof resolve !== 'function') continue;
    let point = null;
    let error = null;
    try {
      point = resolve();
    } catch (err) {
      error = err;
    }
    ok(!error, `${mission}/${part.id} anchor closure does not throw (${error ? error.message : 'ok'})`);
    ok(point && point.isVector3 === true, `${mission}/${part.id} resolves to a THREE.Vector3`);
    ok(
      point && [point.x, point.y, point.z].every(Number.isFinite),
      `${mission}/${part.id} resolves to finite world coordinates`,
    );
  }
  // A def MAY ship a directed fly-through for the anatomy step. `viewer.setAnatomy()` silently
  // falls back to the plain orbit when the spec cannot be resolved against the live rig, which is
  // the right runtime behaviour and a terrible thing to find out from a screenshot: this is the
  // build-time half of it. Content truth for the ssl beats - that the footage each card is held
  // over shows what the card claims - is checked against the decoded payload in ssl-data.test.mjs.
  const tour = def.anatomyTour;
  if (tour) {
    const ids = new Set((parts || []).map((part) => part.id));
    const anchorOf = (part) => (parts || []).find((p) => p.id === part);
    const resolves = (anchorId) => !!anchors && typeof anchors[anchorId] === 'function';
    ok(Array.isArray(tour.beats) && tour.beats.length === ids.size, `${mission} tour has one beat per anatomy card`);
    ok(
      resolves((tour.basis || {}).origin) && resolves((tour.basis || {}).forward),
      `${mission} tour basis anchors resolve against the live scene`,
    );
    ok(
      new Set((tour.beats || []).map((beat) => beat.part)).size === (tour.beats || []).length,
      `${mission} tour beats name distinct cards`,
    );
    // ROUND 7 GRAMMAR. The camera holds ONE wide framing for the whole tour and the part the live
    // card names is highlighted in the scene; the four per-beat close-ups are gone. Both halves are
    // gated here, because both are the kind of thing that fails silently on a screenshot: a tour
    // with no `wide` block is refused by `viewer.setAnatomy()` and falls back to the plain orbit, and
    // a part with neither mesh handles nor a glow radius is a card whose highlight is invisible.
    const wide = tour.wide || {};
    const wideAnchor = typeof wide.anchor === 'string' && wide.anchor ? wide.anchor : (tour.basis || {}).origin;
    ok(
      Array.isArray(wide.pos) && wide.pos.length === 3 && wide.pos.every(Number.isFinite),
      `${mission} tour ships one wide shot with a finite camera offset`,
    );
    ok(resolves(wideAnchor), `${mission} tour wide shot hangs off an anchor that resolves ("${wideAnchor}")`);
    ok(
      wide.frame === undefined || wide.frame === 'robot' || wide.frame === 'world',
      `${mission} tour wide shot names a known frame`,
    );
    for (const key of ['pos', 'posEnd', 'aim', 'aimEnd']) {
      if (wide[key] === undefined) continue;
      ok(
        Array.isArray(wide[key]) && wide[key].length === 3 && wide[key].every(Number.isFinite),
        `${mission} tour wide shot ${key} is three finite metres`,
      );
    }
    // The two ends of the drift are a DRIFT and not a dolly: a wide shot that halves its stand-off
    // over 15 seconds is four close-ups with extra steps. Both ends inside 25 per cent of each other.
    if (Array.isArray(wide.posEnd) && wide.posEnd.every(Number.isFinite)) {
      const len = (v) => Math.hypot(v[0], v[1], v[2]);
      const a = len(wide.pos);
      const b = len(wide.posEnd);
      ok(
        Math.abs(a - b) <= 0.25 * Math.max(a, b),
        `${mission} tour drift holds its stand-off (${a.toFixed(2)} m -> ${b.toFixed(2)} m)`,
      );
    }
    const meshes = scene && typeof scene.partMeshes === 'function' ? scene.partMeshes() || {} : {};
    for (const beat of tour.beats || []) {
      const part = anchorOf(beat.part);
      ok(!!part, `${mission} tour beat "${beat.part}" names a card on the overlay`);
      ok(!!part && resolves(part.anchor), `${mission} tour beat "${beat.part}" resolves its card's anchor`);
      ok(
        Array.isArray(beat.window) && beat.window[0] >= 0 && beat.window[1] > beat.window[0] &&
          beat.window[1] <= def.duration,
        `${mission} tour beat "${beat.part}" window is ordered inside 0..${def.duration}`,
      );
      ok(
        beat.pos === undefined && beat.posEnd === undefined && beat.aim === undefined &&
          beat.aimEnd === undefined && beat.frame === undefined,
        `${mission} tour beat "${beat.part}" carries no camera of its own`,
      );
      const handles = meshes[beat.part];
      const lit = Array.isArray(handles) ? handles.filter((m) => m && m.isMesh).length : handles && handles.isMesh ? 1 : 0;
      const radius = Number.isFinite(beat.glow) ? beat.glow : tour.glow;
      ok(
        lit > 0 || (Number.isFinite(radius) && radius > 0),
        `${mission} tour beat "${beat.part}" has something to light: ${lit} mesh(es) or a glow radius`,
      );
    }
  }

  if (scene && typeof scene.dispose === 'function') scene.dispose();

  const success = exp.success || {};
  const successWindow = success.window;
  ok(
    Array.isArray(successWindow) && successWindow.length === 2 &&
      Number.isFinite(successWindow[0]) && Number.isFinite(successWindow[1]) &&
      successWindow[0] >= 0 && successWindow[0] < successWindow[1] && successWindow[1] <= def.duration,
    `${mission} success window is ordered inside 0..${def.duration} (${JSON.stringify(successWindow)})`,
  );

  const failure = exp.failure || {};
  const finding = (def.findings || []).find((item) => item.id === failure.findingId);
  ok(!!finding, `${mission} failure findingId "${failure.findingId}" resolves`);
  if (!finding) continue;

  // THE SUCCESS STEP MUST NOT SPOIL THE FAULT, and round 6 changed what "the fault" means here.
  //
  // Until now this checked the success window against `finding.window`. That held while the two
  // were the same thing, and round 5 stopped them being the same thing: a finding's `window` is the
  // CHART span, written wide enough that the trace either side of the event means something (ssl's
  // kicker sawtooth needs 16.4 s of it, and arm6's overtemp declares the whole 80 s log), while
  // `loop` is the tight span the failure step actually replays. What a visitor must not meet early
  // is the fault MOMENT - the replayed loop and the instant the finding points at - not the context
  // the chart happens to plot around it. ssl's round-6 success window is the goal at 62.7 s, which
  // is inside `kicker-charge`'s 46.34-62.74 s chart span and eight seconds clear of its 53.48-54.63 s
  // loop: a shared span, not a shared cause, and the old assertion could not tell the two apart.
  //
  // So: no overlap with any REPLAY span, and no finding's instant inside the window. A finding with
  // no `loop` replays its window (`flow.js`), so that is its replay span - except when the window is
  // the whole log, which is a declaration that the channel is context for every second of the
  // mission and which no success window could avoid. There the instant is the only guard, and it is
  // the right one: it is the second the failure step seeks to.
  for (const item of def.findings || []) {
    const replay = Array.isArray(item.loop) ? item.loop : item.window;
    const wholeLog = Array.isArray(replay) && replay[0] <= 0 && replay[1] >= def.duration;
    const kind = Array.isArray(item.loop) ? 'loop' : 'window';
    if (Array.isArray(replay) && !wholeLog) {
      ok(
        !overlaps(successWindow, replay),
        `${mission} success window does not overlap ${item.id} ${kind} ${JSON.stringify(replay)}`,
      );
    }
    ok(
      !Number.isFinite(item.t) || item.t < successWindow[0] || item.t > successWindow[1],
      `${mission} success window does not contain ${item.id} t=${item.t}`,
    );
  }

  const plotted = failure.plottedFields || finding.focus || {};
  const channel = (def.channels || []).find((item) => item.path === plotted.channel);
  ok(!!channel, `${mission} plotted channel "${plotted.channel}" resolves`);
  const fieldMap = new Map(((channel && channel.fields) || []).map((field) => [field.key, field]));
  ok(Array.isArray(plotted.fields) && plotted.fields.length > 0, `${mission} selects at least one plotted field`);
  ok(
    (plotted.fields || []).every((field) => fieldMap.has(field)),
    `${mission} plotted fields are a subset of ${plotted.channel}`,
  );
  const labels = (plotted.fields || []).map((field) => (fieldMap.get(field) || {}).label || field);
  ok(labels.length === (plotted.fields || []).length, `${mission} has one direct label per plotted field`);
  ok(labels.every((label) => typeof label === 'string' && label.trim()), `${mission} direct labels are non-empty`);
  ok(new Set(labels).size === labels.length, `${mission} direct labels map one-to-one to plotted fields (${labels.join(', ')})`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
