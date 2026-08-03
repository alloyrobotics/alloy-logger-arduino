// role-registers.test.mjs - the register maps (`answerByRole`, `sayByRole`) against the live role
// table, across every hand-written robot AND both lazy guided side-modules.
//
//   node demo/js/robots/gen-fixture/role-registers.test.mjs
//
// WHY THIS EXISTS. Roles v2 retired `operator` and `support` and added `hobbyist` and `marketing`.
// role.js, worker/roles.js and the worker's register table were all updated; three `answerByRole`
// maps were not, and they still keyed only the retired ids. `getRoleId()` degrades a retired id to
// `engineer` BEFORE chat.js's `answerFor()` runs, so those keys could never be selected again: a
// hobbyist tapping the first card was served the engineer table on the one answer the guided walk
// is built around, while the agent line one bubble above it was in their own register. Nothing
// caught it, because nothing anywhere asserted that a register map's keys are role ids.
//
// What it proves:
//   1  every key of every register map is a LIVE role id, and never `engineer` (the default IS the
//      unkeyed `answer` / `say`, so keying it is a second copy of the same register)
//   2  every value is a non-empty string
//   3  a role GUIDED into a mission is keyed on that mission's opener and on every one of its
//      beats, unless that role is the engineer default. This is the regression, stated directly:
//      the four cards promise "the analyst speaks your language" and this is where that is true
//   4  every beat's `answer` names a real script entry and every action's `evidence` a real
//      finding, so the walk cannot point at something the def does not have

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRobotDefinition } from '../../../../worker/build-facts.mjs';
import { ROLES, ROLE_IDS, DEFAULT_ROLE_ID, isGuidedMission } from '../../core/role.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROBOTS = path.join(HERE, '..');

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const section = (n) => console.log(`\n${n}`);

/** Hand-written robots. `stub` is the fixture template and ships no registers. */
const IDS = ['sbr', 'rescue', 'arm6', 'drone', 'ssl', 'battle', 'donna'];

/** Load a def and merge whatever its lazy guided module would have merged at runtime. */
async function loadWithGuided(id) {
  const def = await loadRobotDefinition(id);
  for (const rel of [`${id}/role-openers.js`, `${id}/guided.js`]) {
    const abs = path.join(ROBOTS, rel);
    let mod = null;
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (_) {
      continue; // this robot ships no side-module, which is not a failure
    }
    ok(typeof mod.applyGuided === 'function', `${rel} exports applyGuided()`);
    if (typeof mod.applyGuided === 'function') mod.applyGuided(def);
  }
  return def;
}

const defs = new Map();
for (const id of IDS) defs.set(id, await loadWithGuided(id));

// ---------------------------------------------------------------- 1 + 2. keys and values

section('register map keys are live role ids');
const LIVE = new Set(ROLE_IDS);
for (const [id, def] of defs) {
  const maps = [];
  for (const entry of def.script || []) {
    if (entry.answerByRole) maps.push([`${id}/script[${entry.id}].answerByRole`, entry.answerByRole]);
  }
  for (const beat of (def.choreo && def.choreo.beats) || []) {
    if (beat.sayByRole) maps.push([`${id}/choreo[${beat.id}].sayByRole`, beat.sayByRole]);
  }
  for (const [where, map] of maps) {
    for (const key of Object.keys(map)) {
      ok(LIVE.has(key), `${where}: "${key}" is a live role id (a retired id is degraded upstream and can never be selected)`);
      ok(key !== DEFAULT_ROLE_ID, `${where}: "${key}" is not the default register, which is the unkeyed copy itself`);
      const v = map[key];
      ok(typeof v === 'string' && v.trim().length > 0, `${where}.${key} is a non-empty string`);
    }
  }
}

// ---------------------------------------------------------------- 3. the guided promise

section('a role guided into a mission is keyed on that mission');
for (const role of ROLES) {
  const def = defs.get(role.mission);
  ok(!!def, `${role.id}: its mission "${role.mission}" is a real robot`);
  if (!def) continue;
  ok(isGuidedMission(role.mission), `${role.id}: "${role.mission}" is in the guided set`);
  const beats = (def.choreo && def.choreo.beats) || [];
  ok(beats.length > 0, `${role.mission}: ships choreography beats`);
  if (role.id === DEFAULT_ROLE_ID) continue; // the default register IS the unkeyed copy

  for (const beat of beats) {
    ok(
      !!(beat.sayByRole && typeof beat.sayByRole[role.id] === 'string' && beat.sayByRole[role.id].trim()),
      `${role.mission}/choreo[${beat.id}]: authored for the "${role.id}" register it is guided into`,
    );
  }
  const opener = beats.find((b) => b.answer);
  ok(!!opener, `${role.mission}: a beat references the scripted opener`);
  if (!opener) continue;
  const entry = (def.script || []).find((e) => e.id === opener.answer);
  ok(!!entry, `${role.mission}: the opener beat names a real script entry ("${opener.answer}")`);
  if (!entry) continue;
  ok(
    !!(entry.answerByRole && typeof entry.answerByRole[role.id] === 'string' && entry.answerByRole[role.id].trim()),
    `${role.mission}/script[${entry.id}]: the opener answers in the "${role.id}" register it is guided into`,
  );
}

// ---------------------------------------------------------------- 4. the walk resolves

section('every beat reference resolves');
for (const [id, def] of defs) {
  const beats = (def.choreo && def.choreo.beats) || [];
  if (!beats.length) continue;
  const entries = new Set((def.script || []).map((e) => e.id));
  const findings = new Set((def.findings || []).map((f) => f.id));
  for (const beat of beats) {
    ok(typeof beat.id === 'string' && beat.id.trim(), `${id}: every beat carries a stable id`);
    ok(typeof beat.cta === 'string' && beat.cta.trim(), `${id}/choreo[${beat.id}]: carries a CTA label`);
    if (beat.answer) ok(entries.has(beat.answer), `${id}/choreo[${beat.id}]: answer "${beat.answer}" is a script entry`);
    for (const a of beat.actions || []) {
      ok(findings.has(a.evidence), `${id}/choreo[${beat.id}]: action evidence "${a.evidence}" is a finding`);
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
