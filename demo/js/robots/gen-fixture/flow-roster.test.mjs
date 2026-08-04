// flow-roster.test.mjs - the public mission library and role routing contract.

import { ROBOTS, PICKER_ROBOTS, ROBOTS_BY_ID } from '../index.js';
import { ROLES, missionFor, DEFAULT_MISSION, LEGACY_ROLE_IDS } from '../../core/role.js';

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

section('public roster');
const pickerIds = PICKER_ROBOTS.map((def) => def.id);
ok(
  JSON.stringify(pickerIds) === JSON.stringify(['arm6', 'drone', 'ssl', 'donna']),
  `PICKER_ROBOTS is exactly arm6, drone, ssl, donna (${pickerIds.join(', ')})`,
);
ok(new Set(pickerIds).size === 4, 'the public roster contains no duplicate mission');
ok(PICKER_ROBOTS.every((def) => ROBOTS_BY_ID.get(def.id) === def), 'every picker definition is the registry definition');

section('complete route registry');
const cannedIds = ROBOTS.map((def) => def.id);
const expectedCanned = ['sbr', 'arm6', 'drone', 'rescue', 'ssl', 'battle', 'donna'];
ok(
  expectedCanned.every((id) => ROBOTS_BY_ID.has(id)),
  `ROBOTS_BY_ID retains all seven canned missions (${expectedCanned.filter((id) => ROBOTS_BY_ID.has(id)).join(', ')})`,
);
ok(ROBOTS_BY_ID.size === expectedCanned.length, `the canned registry starts with seven entries (${ROBOTS_BY_ID.size})`);
ok(new Set(cannedIds).size === expectedCanned.length, 'the canned registry contains no duplicate id');

section('role routing');
const expectedRoles = {
  hobbyist: 'arm6',
  engineer: 'ssl',
  lead: 'ssl',
  marketing: 'donna',
};
for (const role of ROLES) {
  ok(expectedRoles[role.id] === role.mission, `${role.id} is authored to ${expectedRoles[role.id]} (${role.mission})`);
  ok(missionFor(role.id) === expectedRoles[role.id], `${role.id} resolves through missionFor()`);
  ok(PICKER_ROBOTS.some((def) => def.id === role.mission), `${role.id}'s mission is in the public roster`);
}
ok(DEFAULT_MISSION === 'arm6', `the unknown-role default is arm6 (${DEFAULT_MISSION})`);
ok(missionFor(null) === 'arm6', 'a missing role resolves to arm6');
ok(missionFor('unknown-role') === 'arm6', 'an unknown role resolves to arm6');
ok(LEGACY_ROLE_IDS.operator === 'engineer', 'the operator alias still degrades to engineer');
ok(LEGACY_ROLE_IDS.support === 'engineer', 'the support alias still degrades to engineer');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
