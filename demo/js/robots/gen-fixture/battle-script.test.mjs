// battle-script.test.mjs - self-test for demo/js/robots/battle/script.js, the RobotDefinition.
//
//   node demo/js/robots/gen-fixture/battle-script.test.mjs
//
// This directory is in .assetsignore, so nothing here is ever served. The def is loaded through
// build-facts.mjs's own loader, which stubs the scene.js import: that is the same code path the
// facts builder uses, so a change that breaks the builder breaks this test first.
//
// What it proves:
//   1  every scripted entry is reachable from its own matchers AND from a natural phrasing a
//      visitor would actually type, nothing shadows anything, and firstQuestion plus every
//      suggested chip resolve to the entry they were written for
//   2  every evidence id and every {{ev:}} token names a finding this robot owns, and all four
//      fault-chain findings are reachable from a scripted answer
//   3  the answers hold to the house format (short verdict sentence first, well-formed 2 column
//      tables) and there is no em dash or en dash anywhere in the def
//   4  DISCLOSURE. All the surfaces the plan commits to really carry the words: context.provenance,
//      the client-rendered chatProvenance line, the picker footer in index.html, and the scripted
//      provenance answer, which may never call this simulated round recorded or real
//   5  CORRECT-CAUSALITY. The inverse of the SSL mission's problem. Here the causal chain IS in the
//      data, so the chain and result answers MUST name Blue 1's own overheat, and MUST NOT contain
//      an affirmative construction blaming enemy fire (the same negation-guarded regex the worker
//      smoke probe grades the live model with)
//   6  every numeric token in every scripted answer is registered in claims.mjs, so an answer
//      cannot quote a number the payload does not carry
//   7  the facts-table budget knob is the plan-pinned 40 and survives build-facts' own clamp
//   8  the def contract: id, duration, the lazy-payload surface, and a heroTime() that lands
//      before the failure on BOTH payloads (the preview slice and the loaded round)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRobotDefinition } from '../../../../worker/build-facts.mjs';
import { matchEntry } from '../../core/matcher.js';
import * as C from '../battle/claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const eq = (actual, expected, msg) =>
  ok(Object.is(actual, expected), `${msg}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
const section = (n) => console.log(`\n${n}`);

const def = await loadRobotDefinition('battle');
const findingIds = new Set(def.findings.map((f) => f.id));

/** Prose the visitor reads. Matchers are search vocabulary, not copy, and are excluded on purpose. */
const PROSE = {
  name: def.name,
  device: def.device,
  tagline: def.tagline,
  'context.system': def.context.system,
  'context.mission': def.context.mission,
  'context.fault': def.context.fault,
  'context.cardProblem': def.context.cardProblem,
  'context.label': def.context.label,
  'context.provenance': def.context.provenance,
  chatProvenance: def.chatProvenance,
  firstQuestion: def.firstQuestion,
};
def.suggested.forEach((q, i) => {
  PROSE[`suggested[${i}]`] = q;
});
for (const e of def.script) PROSE[`script.${e.id}`] = e.answer;

// ---------------------------------------------------------------- 1. matchers

section('1. matchers');
for (const entry of def.script) {
  for (const m of entry.matchers) {
    const hit = matchEntry(def.script, m);
    ok(hit === entry, `matcher "${m}" resolves to its own entry (got ${hit && hit.id}, want ${entry.id})`);
  }
}
{
  // Source order breaks ties, so an entry declared LATER can be unreachable while every one of its
  // matchers still "works" in isolation. Firing the whole matcher set at once is what catches that.
  const reached = new Set(def.script.map((e) => (matchEntry(def.script, e.matchers.join(' ')) || {}).id));
  eq(reached.size, def.script.length, 'every entry is the best match for its own matcher set, so nothing is shadowed');
}

// The matchers are the plumbing; these are questions a visitor would type. Written from the
// storyline rather than from the matcher list, so a matcher edit that keeps the unit test green
// while breaking real phrasing still fails here.
section('1b. natural phrasing');
{
  const NATURAL = {
    'chain-overview': 'Why did Blue 1 lose 548 HP with no enemy anywhere near it?',
    'stale-track': 'What went stale at 72 seconds?',
    'blind-burst': 'Why did the fire controller keep shooting into an obstacle?',
    'heat-rule': 'How does barrel heat turn into HP loss?',
    'round-result': 'Who won the round, and why?',
    'provenance': 'Is this a real recorded match or a simulation?',
  };
  eq(Object.keys(NATURAL).length, def.script.length, 'every scripted entry has a natural phrasing in this test');
  for (const [id, q] of Object.entries(NATURAL)) {
    ok(findingIds.size >= 0 && def.script.some((e) => e.id === id), `the entry "${id}" exists to be asked for`);
    const hit = matchEntry(def.script, q);
    ok(hit && hit.id === id, `"${q}" resolves to ${id} (got ${hit && hit.id})`);
  }
}

// ---------------------------------------------------------------- 2. authored questions

section('2. authored questions');
{
  const first = matchEntry(def.script, def.firstQuestion);
  ok(!!first, 'firstQuestion resolves to an entry');
  eq(first && first.id, 'chain-overview', 'firstQuestion opens on the whole fault chain');
  ok(first && (first.evidence || []).length > 0, 'the opener resolves to an evidence-bearing entry');
  const wanted = { 'What went stale at 72 seconds?': 'stale-track', 'How does barrel heat turn into HP loss?': 'heat-rule', 'Who won the round, and why?': 'round-result' };
  for (const q of def.suggested) {
    const hit = matchEntry(def.script, q);
    ok(!!hit, `suggested question resolves: "${q}"`);
    if (wanted[q]) eq(hit && hit.id, wanted[q], `the chip "${q}" lands on the entry it was written for`);
  }
  ok(new Set(def.suggested).size === def.suggested.length, 'no duplicate suggested chips');
  ok(
    new Set(def.suggested.map((q) => (matchEntry(def.script, q) || {}).id)).size === def.suggested.length,
    'the three chips lead to three DIFFERENT entries',
  );
}

// ---------------------------------------------------------------- 3. evidence ids

section('3. evidence');
for (const entry of def.script) {
  for (const id of entry.evidence || []) {
    ok(findingIds.has(id), `${entry.id}: evidence id \`${id}\` is a finding`);
  }
  for (const m of entry.answer.matchAll(/\{\{ev:([a-z0-9_-]+)\}\}/gi)) {
    ok(findingIds.has(m[1]), `${entry.id}: {{ev:${m[1]}}} names a finding`);
    ok((entry.evidence || []).includes(m[1]), `${entry.id}: {{ev:${m[1]}}} is also declared in evidence[]`);
  }
}
{
  const cited = new Set(def.script.flatMap((e) => e.evidence || []));
  // The four fault-chain findings are the storyline and every one of them must be one click away.
  // `buff-halved-damage` and `uwb-yaw-residual` are deliberately NOT scripted: they are the model's
  // to reach through the facts pack, and DESIGN.md documents them that way.
  for (const id of ['stale-track', 'frozen-goal', 'blind-burst', 'overheat-self-damage']) {
    ok(cited.has(id), `the chain finding \`${id}\` is reachable from a scripted answer`);
  }
  for (const f of def.findings) ok(findingIds.has(f.id), `finding \`${f.id}\` has an id`);
}

// ---------------------------------------------------------------- 4. house format

section('4. answer format');
for (const entry of def.script) {
  const lines = entry.answer.split('\n');
  const verdict = lines[0].trim();
  const words = verdict.split(/\s+/).length;
  ok(words <= 20, `${entry.id}: the verdict line is one short sentence, <= 20 words (${words})`);
  ok(/[.!?]$/.test(verdict), `${entry.id}: verdict line is a sentence`);
  ok(!verdict.startsWith('|'), `${entry.id}: the answer opens with the verdict, not with a table`);
  const rows = lines.filter((l) => l.trim().startsWith('|'));
  for (const row of rows) {
    const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    eq(cells.length, 2, `${entry.id}: table row has exactly 2 columns: ${row.trim().slice(0, 60)}`);
  }
  if (rows.length) {
    // A markdown table is header, separator, then at least one body row, and the separator has to be
    // the SECOND line of the run or nothing renders as a table at all.
    ok(rows.length >= 3, `${entry.id}: a table that exists has a header, a rule and a body (${rows.length} rows)`);
    ok(/^\|[\s:-]+\|[\s:-]+\|$/.test(rows[1].trim()), `${entry.id}: the second table row is the separator rule`);
    const first = lines.findIndex((l) => l.trim().startsWith('|'));
    const run = lines.slice(first, first + rows.length).every((l) => l.trim().startsWith('|'));
    ok(run, `${entry.id}: the table rows are contiguous, so the block renders as one table`);
  }
}
{
  const withTables = def.script.filter((e) => e.answer.split('\n').some((l) => l.trim().startsWith('|')));
  ok(withTables.length >= 4, `most entries carry an evidence table (${withTables.length}/${def.script.length})`);
}

// Built from code points so that this file does not itself contain the characters it bans.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
section('4b. dashes');
{
  const copy = JSON.stringify({
    name: def.name,
    device: def.device,
    tagline: def.tagline,
    context: def.context,
    firstQuestion: def.firstQuestion,
    suggested: def.suggested,
    chatProvenance: def.chatProvenance,
    script: def.script,
    findings: def.findings,
    channels: def.channels,
    rateNotes: def.rateNotes,
  });
  ok(!copy.includes(EM), 'no em dash anywhere in the def');
  ok(!copy.includes(EN), 'no en dash anywhere in the def');
}

// ---------------------------------------------------------------- 5. disclosure surfaces

// This mission is FULLY synthetic, so the disclosure is not a caveat on part of it: it is the
// description of the whole thing. Four surfaces carry it and none of them depends on a model.
section('5. disclosure surfaces');
{
  ok(typeof def.context.provenance === 'string' && def.context.provenance.length > 80,
    'context.provenance carries the honesty line the brief screen renders');
  ok(/simulated/i.test(def.context.provenance), 'the brief provenance line says the round is simulated');
  ok(/synthetic/i.test(def.context.provenance), 'and that the streams are synthetic');

  ok(typeof def.chatProvenance === 'string' && def.chatProvenance.length > 60,
    'the def ships a client-rendered chat provenance line');
  ok(/synthetic/i.test(def.chatProvenance), 'chatProvenance says the telemetry is synthetic');
  ok(/simulat/i.test(def.chatProvenance), 'chatProvenance says the round is simulated');

  const chat = await readFile(path.join(HERE, '..', '..', 'core', 'chat.js'), 'utf8');
  ok(/robotDef\.chatProvenance/.test(chat), 'chat.js renders the line from the def rather than from a model answer');

  const html = await readFile(path.join(HERE, '..', '..', '..', 'index.html'), 'utf8');
  ok(
    html.includes('Two synthetic missions'),
    'the picker footer counts the two synthetic missions still in the public roster',
  );
  ok(
    html.includes(
      "Two synthetic missions, one real match replay with planted fault overlays, and one real match replayed from three robots' onboard logs. Runs entirely in your browser.",
    ),
    'the picker footer sentence is the authored copy, verbatim',
  );

  // "recorded" and "real match" may appear ONLY inside a sentence that denies them. This is the
  // whole disclosure argument in one assertion: a sentence like "recorded during the 2019 event"
  // fails, "nothing here was recorded from a real match" passes.
  const NEGATED = /\b(no|not|never|nothing|none|rather than|instead of|neither)\b/i;
  const CLAIMS_REAL = /\brecorded\b|\breal match\b|\bactual match\b/i;
  for (const [where, text] of Object.entries(PROSE)) {
    for (const sentence of String(text).split(/(?<=[.!?:])\s+|\n/)) {
      if (!CLAIMS_REAL.test(sentence)) continue;
      ok(
        NEGATED.test(sentence),
        `${where}: "recorded"/"real match" appears only under a negation, never as a claim: "${sentence.trim()}"`,
      );
    }
  }
  const prov = def.script.find((e) => e.id === 'provenance');
  ok(!!prov, 'the provenance entry exists');
  ok(prov && /simulat/i.test(prov.answer), 'the provenance answer calls the round simulated');
  ok(prov && /scripted|authored|generated/i.test(prov.answer), 'and says the round was authored rather than captured');
  ok(prov && CLAIMS_REAL.test(prov.answer), 'the provenance answer confronts the "was this real" question head on');
}

// ---------------------------------------------------------------- 6. correct causality

// The inverse of the SSL mission. There the causal link was unknowable and asserting it was the
// failure; here the chain IS in the data (Blue 1's loss is its own barrel overheat, logged as
// EXCEED_HEAT with no damage source) and the failure mode is blaming enemy fire, which is what a
// reader pattern-matching "HP dropped in a battle" reaches for. Same graders the worker's smoke
// probe holds the live model to, applied to the scripted copy the model is grounded on.
section('6. correct causality');
{
  const NAMES_OVERHEAT = /overheat|barrel heat|heat limit|exceed[_ ]?heat/i;
  const SELF =
    /its own|self[- ]inflicted|itself|own (?:hp|barrel|burst|fire|shots?)|no (?:enemy|red|opponent)|(?:paid|deducted|cost)[^.?!]{0,40}(?:hp|penalt)|overheat penalt/i;
  // Affirmative causal constructions blaming enemy fire. Negated forms ("not because of enemy
  // fire", "never hit by Red") are correct statements and must not trip the check.
  const BLAMES_ENEMY =
    /(?<!\bnot\s)(?<!\bnever\s)\b(because of|due to|caused by|as a result of|from)\b[^.?!]{0,60}\b(red\b|redline|enemy|opponent)[^.?!]{0,40}\b(fire|shot|hit|projectile|attack)/i;

  for (const id of ['chain-overview', 'round-result']) {
    const entry = def.script.find((e) => e.id === id);
    ok(!!entry, `the ${id} entry exists`);
    if (!entry) continue;
    ok(NAMES_OVERHEAT.test(entry.answer), `${id}: names the barrel overheat`);
    ok(SELF.test(entry.answer), `${id}: marks the loss as Blue 1's own`);
    const m = BLAMES_ENEMY.exec(entry.answer);
    ok(!m, `${id}: never attributes the loss to enemy fire${m ? ` ("${m[0]}")` : ''}`);
  }
  // And nowhere else in the copy either.
  for (const [where, text] of Object.entries(PROSE)) {
    const m = BLAMES_ENEMY.exec(String(text));
    ok(!m, `${where}: no affirmative enemy-fire attribution${m ? ` ("${m[0]}")` : ''}`);
  }
  // The opener must not smuggle the wrong premise in either: it asks about a loss with no enemy.
  ok(/no enemy/i.test(def.firstQuestion), `the opener states the absence of an enemy: "${def.firstQuestion}"`);
}

// ---------------------------------------------------------------- 7. numbers, against the ledger

// battle-data.test.mjs runs this scan over the FINDING narratives. The scripted answers are the
// other half of the copy and they quote more numbers than the findings do, so they get the same
// treatment: a number in an answer is registered in claims.mjs or it is a build failure.
section('7. every number is in the claim ledger');
{
  const allowedNumbers = C.allowedNumbers();
  const allowedTexts = C.allowedTexts();

  // A claim BOUND to a timestamp registers that timestamp as much as it registers its value: the
  // table row "72.3 s, goal frozen" quotes the instant `goalFrozenM` is resolved against.
  for (const k of Object.keys(C.DATA_CLAIMS)) {
    const t = C.DATA_CLAIMS[k].tOrEventId;
    if (typeof t === 'number') allowedNumbers.add(t);
  }

  // Identifiers are not claims. Three kinds put digits in a sentence that are part of a NAME, and
  // all three come out of the text before it is tokenized:
  //   - channel paths and field keys (`/blue1/referee`, `shooterHeat0`, `trackAgeS`)
  //   - the competition and manual identifiers, which are titles ("ICRA 2019", "V1.1")
  //   - the projectile CLASS name, which the rules manual itself writes as "17 mm" while the
  //     measured diameter in the ledger is 16.9 mm
  const identifiers = ['ICRA 2019', 'V1.1', '17 mm'];
  for (const c of def.channels) {
    identifiers.push(c.path);
    for (const f of c.fields) identifiers.push(f.key);
  }
  identifiers.sort((a, b) => b.length - a.length);
  const deIdentify = (s) => identifiers.reduce((acc, id) => acc.split(id).join(' '), s);

  // Two numbers the copy prints that the ledger holds in another form. Both are stated here rather
  // than waved through by a loose regex, so adding a third is a deliberate act.
  const DERIVED = new Map([
    [0, 'the zero baseline (trackAgeS ramps FROM 0)'],
    [100, '100 ms is the reciprocal of the ledger\'s 10 Hz settlement rate'],
  ]);

  const bad = [];
  let total = 0;
  for (const [where, text] of Object.entries(PROSE)) {
    for (const m of deIdentify(String(text)).matchAll(/-?\d+(?:\.\d+)?/g)) {
      total++;
      const tok = m[0];
      if (allowedTexts.has(tok)) continue;
      if (allowedNumbers.has(Number(tok))) continue;
      if (DERIVED.has(Number(tok))) continue;
      bad.push(`${where}: "${tok}"`);
    }
  }
  eq(bad.length, 0, `every number in the scripted copy is in the claim ledger  ${bad.slice(0, 6).join(' | ')}`);
  ok(total > 40, `the copy quotes ${total} numeric tokens, so the scan has something to catch`);
  // Not vacuous in the other direction either: the headline number really is a ledger claim.
  eq(C.value('overheatLossHP'), 548, 'the headline 548 HP is the ledger claim the copy prints');
  ok(def.firstQuestion.includes(C.text('overheatLossHP')), 'and the opener prints it as the ledger spells it');
  ok(def.tagline.includes(C.text('overheatLossHP')), 'and so does the picker tagline');
}

// ---------------------------------------------------------------- 8. facts-table budget knob

// ------------------------------------------------- 7b. load-bearing phrases bind to their claims
//
// The global numeric scan above proves no UNREGISTERED number ships, but it cannot prove a number
// is the RIGHT one: "8 x 8 m" would pass it because 8 is admitted by the eight-tick claim. These
// are the copy's load-bearing quantitative phrases, asserted verbatim against the surface that
// carries them AND against the semantic claim entry that backs them, so changing either side of
// the pairing is a build failure.
section('7b. phrase bindings');
{
  const K = C.CITED_CONSTANTS;
  const D = C.DATA_CLAIMS;
  const bind = (surface, text, phrase, entries) => {
    ok(String(text).includes(phrase), `${surface} carries the phrase "${phrase}"`);
    for (const [name, entry, expect] of entries) {
      const v = entry && (entry.value !== undefined ? entry.value : entry.expected);
      ok(v === expect, `"${phrase}" is backed by ${name} = ${expect}`);
    }
  };
  bind('context.system', def.context.system, '8 x 5 m arena', [
    ['arenaLengthM', K.arenaLengthM, 8],
    ['arenaWidthM', K.arenaWidthM, 5],
  ]);
  bind('context.system', def.context.system, 'Two fully autonomous robots per team', [
    ['robotsPerTeam', K.robotsPerTeam, 2],
  ]);
  bind('context.system', def.context.system, '2000 HP per robot', [['initialHP', K.initialHP, 2000]]);
  // "17 mm" is the projectile CLASS name (the ledger's measured diameter is 16.9 mm); the number
  // that binds here is the damage value.
  bind('context.system', def.context.system, '50 HP per 17 mm hit', [
    ['armorDamageHP', K.armorDamageHP, 50],
  ]);
  bind('context.system', def.context.system, 'barrel heat limit 180', [['heatLimit', K.heatLimit, 180]]);
  bind('context.fault', def.context.fault, '14-shot burst', [['burstShotCount', D.burstShotCount, 14]]);
  bind('context.fault', def.context.fault, '548 of its own HP', [['overheatLossHP', D.overheatLossHP, 548]]);
  bind('tagline', def.tagline, '548 HP', [['overheatLossHP', D.overheatLossHP, 548]]);
  ok(/2v2/.test(def.name), 'the mission name states the 2v2 format the robotsPerTeam claim backs');
}

section('8. facts series budget');
{
  eq(def.factsSeriesPoints, 40, 'the def pins the whole-mission table at the plan-fixed 40 points');
  // build-facts clamps to 40..80; a knob outside the clamp would silently do nothing.
  const clamped = Math.min(80, Math.max(40, Math.round(def.factsSeriesPoints)));
  eq(clamped, def.factsSeriesPoints, 'the pinned value survives build-facts\' 40..80 clamp unchanged');
}

// ---------------------------------------------------------------- 9. the def contract

section('9. contract');
{
  eq(def.id, 'battle', 'the registry id');
  eq(def.duration, 180.0, 'the mission is the full 180 s round');
  ok(typeof def.loadSceneData === 'function', 'def.loadSceneData()');
  ok(typeof def.isSceneDataLoaded === 'function', 'def.isSceneDataLoaded()');
  ok(typeof def.getSceneData === 'function', 'def.getSceneData()');
  ok(typeof def.eventLines === 'function', 'def.eventLines(), the facts hook');
  ok(def.previewData && typeof def.previewData === 'object', 'def.previewData decoded at module scope');
  ok(def.rates && Object.keys(def.rates).length === def.channels.length, 'a cadence per channel');
  ok(def.rateNotes && Object.keys(def.rateNotes).length === def.channels.length, 'a cadence note per channel');

  const src = await readFile(path.join(HERE, '..', 'battle', 'script.js'), 'utf8');
  ok(
    /^import \{ buildScene \} from '\.\/scene\.js';$/m.test(src),
    "the scene import line is verbatim what build-facts.mjs's stub regex matches",
  );

  // heroTime on BOTH payloads. stage3d's rule is that a hero pose never shows the wreck, and the
  // preview slice is a re-based 6 s window, so the two answers are different numbers that both have
  // to land before the 72.0 s failure on their own clock.
  ok(def.isSceneDataLoaded() === false, 'the round payload is NOT loaded by importing the def');
  const tPreview = def.heroTime();
  ok(Number.isFinite(tPreview), `heroTime() is finite on the preview slice (${tPreview})`);
  ok(tPreview >= 0 && tPreview < 72.0, `and lands before the 72.0 s failure (${tPreview})`);
  // The decoder keeps ABSOLUTE round time; a value outside [t0, t1] would clamp to the slice edge
  // and silently pose the first frame, which is the bug this assertion exists to catch.
  const w = def.previewData.window;
  ok(
    tPreview > w.t0 && tPreview < w.t1,
    `and lies strictly inside the decoded preview window ${w.t0}..${w.t1} (${tPreview})`,
  );

  await def.loadSceneData();
  ok(def.isSceneDataLoaded(), 'the round payload loads');
  const tMatch = def.heroTime();
  ok(Number.isFinite(tMatch), `heroTime() is finite on the loaded round (${tMatch})`);
  ok(tMatch >= 0 && tMatch < 72.0, `and still lands before the 72.0 s failure (${tMatch})`);
  ok(tMatch < def.duration, 'and inside the round');
  ok(tMatch !== tPreview, 'the two payloads pose different instants, so the clock really is switched on');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
