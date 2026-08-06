// role-registers.test.mjs - role routes resolve to experience copy without retired guide data.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRobotDefinition } from '../../../../worker/build-facts.mjs';
import { ROLES, ROLE_IDS, DEFAULT_ROLE_ID, hasExperience } from '../../core/role.js';
import { getFlowCopy } from '../../core/flow-copy.js';
import { matchEntry } from '../../core/matcher.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROBOTS = path.join(HERE, '..');
const IDS = ['sbr', 'rescue', 'arm6', 'drone', 'ssl', 'battle', 'donna'];

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

async function importIfPresent(rel) {
  try {
    return await import(pathToFileURL(path.join(ROBOTS, rel)).href);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/** Load a def and apply the same lazy side modules its route applies. */
async function loadWithSides(id) {
  const def = await loadRobotDefinition(id);
  for (const rel of [`${id}/role-openers.js`, `${id}/guided.js`, `${id}/experience.js`]) {
    const mod = await importIfPresent(rel);
    if (!mod) continue;
    const apply = mod.applyRoleOpeners || mod.applyExperience;
    ok(typeof apply === 'function', `${rel} exports applyRoleOpeners() or applyExperience()`);
    if (typeof apply === 'function') apply(def);
  }
  return def;
}

const defs = new Map();
for (const id of IDS) defs.set(id, await loadWithSides(id));

section('role missions use the experience and flow-copy contract');
for (const role of ROLES) {
  const def = defs.get(role.mission);
  const copy = getFlowCopy(role.mission, role.id);
  ok(!!def, `${role.id} resolves to the live ${role.mission} definition`);
  ok(hasExperience(def), `${role.id}'s ${role.mission} route has an experience capability`);
  ok(!!def.experience, `${role.id}'s ${role.mission} experience block is attached by its live side module`);
  ok(!!copy, `${role.id}/${role.mission} resolves role-specific flow copy`);
  if (!copy) continue;
  for (const key of ['missionIntro', 'failureIntro', 'firstQuestion', 'followUp']) {
    ok(typeof copy[key] === 'string' && copy[key].trim(), `${role.id}/${role.mission}.${key} is non-empty`);
  }
  ok(
    !Object.prototype.hasOwnProperty.call(copy, 'debugCards'),
    `${role.id}/${role.mission} carries no retired choose-step cards`,
  );
  const opener = matchEntry(def.script, copy.firstQuestion);
  ok(!!opener, `${role.id}/${role.mission} firstQuestion resolves to a scripted answer`);
}

section('register maps use live roles');
const live = new Set(ROLE_IDS);
for (const [id, def] of defs) {
  const maps = [];
  for (const entry of def.script || []) {
    if (entry.answerByRole) maps.push([`${id}/script[${entry.id}].answerByRole`, entry.answerByRole]);
  }
  for (const [where, map] of maps) {
    for (const [roleId, value] of Object.entries(map)) {
      ok(live.has(roleId), `${where}: "${roleId}" is a live role id`);
      ok(roleId !== DEFAULT_ROLE_ID, `${where}: the engineer default stays in the unkeyed copy`);
      ok(typeof value === 'string' && value.trim(), `${where}.${roleId} is non-empty`);
    }
  }
}

section('retired choreography is absent');
for (const [id, def] of defs) {
  ok(!def.choreo, `${id} carries no retired guide beats`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
