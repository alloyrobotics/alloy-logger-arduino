// role-registers.test.mjs - role routes resolve to experience copy, with legacy choreography kept valid.

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
    const apply = mod.applyGuided || mod.applyExperience;
    ok(typeof apply === 'function', `${rel} exports applyGuided() or applyExperience()`);
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
  ok(Array.isArray(copy.debugCards) && copy.debugCards.length === 3, `${role.id}/${role.mission} has three debug cards`);
  for (const [index, card] of (copy.debugCards || []).entries()) {
    ok(
      card && ['title', 'desc', 'time'].every((key) => typeof card[key] === 'string' && card[key].trim()),
      `${role.id}/${role.mission}.debugCards[${index}] is complete`,
    );
  }
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
  for (const beat of (def.choreo && def.choreo.beats) || []) {
    if (beat.sayByRole) maps.push([`${id}/choreo[${beat.id}].sayByRole`, beat.sayByRole]);
  }
  for (const [where, map] of maps) {
    for (const [roleId, value] of Object.entries(map)) {
      ok(live.has(roleId), `${where}: "${roleId}" is a live role id`);
      ok(roleId !== DEFAULT_ROLE_ID, `${where}: the engineer default stays in the unkeyed copy`);
      ok(typeof value === 'string' && value.trim(), `${where}.${roleId} is non-empty`);
    }
  }
}

section('definitions that still carry choreography remain internally valid');
for (const [id, def] of defs) {
  const beats = (def.choreo && def.choreo.beats) || [];
  if (!beats.length) continue;
  const entries = new Set((def.script || []).map((entry) => entry.id));
  const findings = new Set((def.findings || []).map((finding) => finding.id));
  ok(new Set(beats.map((beat) => beat.id)).size === beats.length, `${id} choreography beat ids are unique`);
  for (const beat of beats) {
    ok(typeof beat.id === 'string' && beat.id.trim(), `${id}: every beat carries a stable id`);
    ok(typeof beat.cta === 'string' && beat.cta.trim(), `${id}/choreo[${beat.id}] carries a CTA label`);
    if (beat.answer) ok(entries.has(beat.answer), `${id}/choreo[${beat.id}] answer "${beat.answer}" is a script entry`);
    for (const action of beat.actions || []) {
      ok(findings.has(action.evidence), `${id}/choreo[${beat.id}] evidence "${action.evidence}" is a finding`);
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
