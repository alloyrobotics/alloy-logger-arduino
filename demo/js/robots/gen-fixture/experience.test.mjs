// experience.test.mjs - the four active mission experience blocks resolve against live defs and scenes.

import * as THREE from '../../../vendor/three.module.js';
import { ROBOTS_BY_ID } from '../index.js';
import { applyGuided as applySslSideModule } from '../ssl/role-openers.js';
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
  ok(
    Array.isArray(finding.window) && !overlaps(successWindow, finding.window),
    `${mission} success window does not overlap ${finding.id} ${JSON.stringify(finding.window)}`,
  );

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
