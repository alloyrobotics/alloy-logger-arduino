// flow-copy.test.mjs - every role and mission variant is complete and UI-safe.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowCopy, getFlowCopy } from '../../core/flow-copy.js';
import { conciseOpenerAnswer } from '../../core/chat.js';
import { ROLES, ROLE_IDS } from '../../core/role.js';
import { ROBOTS_BY_ID } from '../index.js';
import { applyRoleOpeners as applySslSideModule } from '../ssl/role-openers.js';
import { applyExperience as applyDonnaExperience } from '../donna/experience.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(HERE, '..', '..', '..');
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

function nonEmpty(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(nonEmpty);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length > 0 && entries.every(([, item]) => nonEmpty(item));
  }
  return value != null;
}

function strings(value, where, out) {
  if (typeof value === 'string') {
    out.push([where, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => strings(item, `${where}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => strings(item, `${where}.${key}`, out));
  }
}

section('16 role and mission variants');
for (const mission of MISSIONS) {
  const block = flowCopy[mission];
  ok(!!block, `${mission} has a flow-copy block`);
  ok(block && nonEmpty(block.base), `${mission}.base is complete and non-empty`);
  for (const role of ROLE_IDS) {
    const authored = block && block[role];
    const resolved = getFlowCopy(mission, role);
    ok(!!authored, `${mission}/${role} is explicitly authored`);
    ok(!!authored && nonEmpty(authored), `${mission}/${role} has no empty field`);
    ok(!!resolved && nonEmpty(resolved), `${mission}/${role} resolves to a complete copy object`);
    ok(
      resolved && !Object.prototype.hasOwnProperty.call(resolved, 'debugCards'),
      `${mission}/${role} carries no retired choose-step cards`,
    );
  }
}
ok(getFlowCopy('not-a-mission', 'engineer') === null, 'an unknown mission has no invented copy');

section('SSL mission explainer');
for (const [variantId, copy] of Object.entries(flowCopy.ssl)) {
  ok(
    copy.missionIntro === 'Soccer, played by autonomous robots.',
    `ssl/${variantId} uses the dead-simple mission explainer`,
  );
}

section('active experience copy');
const ssl = ROBOTS_BY_ID.get('ssl');
const donna = ROBOTS_BY_ID.get('donna');
applySslSideModule(ssl);
applyDonnaExperience(donna);
for (const mission of MISSIONS) {
  const def = ROBOTS_BY_ID.get(mission);
  ok(!!def, `${mission} resolves from the live registry`);
  ok(!!(def && def.experience), `${mission} carries its experience block after its live side module is applied`);
  const experienceStrings = [];
  if (def && def.experience) strings(def.experience, `def.${mission}.experience`, experienceStrings);
  ok(
    experienceStrings.length > 0 && experienceStrings.every(([, text]) => text.trim().length > 0),
    `${mission}'s experience copy and labels are non-empty`,
  );
}

section('SSL opener stays concise in every role');
{
  const opener = ssl.script.find((entry) => entry.id === 'kicker-charge');
  const answers = [opener.answer, ...Object.values(opener.answerByRole || {})];
  for (const [index, authored] of answers.entries()) {
    const answer = conciseOpenerAnswer(authored);
    ok(
      !/nothing the fleet actually did in this window follows from it/i.test(answer),
      `ssl opener register ${index + 1} omits the repeated provenance paragraph in chat`,
    );
    ok(/\{\{ev:kicker-charge\}\}/.test(answer), `ssl opener register ${index + 1} keeps inline evidence`);
  }
}

section('drone opener replaces the outcome-only filler');
{
  const opener = ROBOTS_BY_ID.get('drone').script.find((entry) => entry.id === 'why-failed');
  const answer = conciseOpenerAnswer(opener.answer, opener.chatCausal);
  ok(!/92% of the survey/i.test(answer), 'drone chat opener drops the outcome-only filler');
  ok(/rpm halved while pwm3 railed/i.test(answer), 'drone chat opener keeps one causal line');
  ok(/\{\{ev:dip\}\}/.test(answer), 'drone chat opener keeps inline evidence');
}

section('copy safety');
const copyStrings = [];
strings(flowCopy, 'flowCopy', copyStrings);
for (const role of ROLES) {
  strings(
    { label: role.label, blurb: role.blurb, kicker: role.kicker },
    `role.${role.id}`,
    copyStrings,
  );
}
for (const mission of MISSIONS) {
  const def = ROBOTS_BY_ID.get(mission);
  strings(
    {
      name: def.name,
      device: def.device,
      tagline: def.tagline,
      cardProblem: def.context && def.context.cardProblem,
      experience: def.experience,
    },
    `def.${mission}`,
    copyStrings,
  );
}

const html = await readFile(path.join(DEMO, 'index.html'), 'utf8');
const visibleHtml = html
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
copyStrings.push(['index.html visible text', visibleHtml]);

const metaLabel = /(^|[\n.!?]\s+)(Plain-language version|Summary|Analysis)\s*:/i;
for (const [where, text] of copyStrings) {
  ok(!text.includes('—'), `${where} contains no em dash`);
  ok(!metaLabel.test(text), `${where} contains no exposed meta-output label`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
