// donna-script.test.mjs - integration contract for Donna's RobotDefinition.
//
// The mission is a real onboard rosbag2 recording, converted offline for this demo. These checks
// keep its attribution, role split, claim bindings and lazy replay contract honest.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsSection as renderEventsSection, loadRobotDefinition } from '../../../../worker/build-facts.mjs';
import { matchEntry } from '../../core/matcher.js';
import * as C from '../donna/claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATTRIBUTION =
  "Recorded onboard by Donna, the Hamburg Bit-Bots' Wolfgang-OP humanoid, during a RoboCup German Open 2025 match. The team publishes their game logs openly; this replay is derived from that recording with thanks.";
const FOOTER =
  'Five synthetic missions, one real match replay with planted fault overlays, and one real recorded robot log. Runs entirely in your browser.';
const CHAT_PROVENANCE =
  "Real recorded mission: captured onboard by the robot's ROS 2 logger at RoboCup German Open 2025, converted offline for this demo, and replayed here. Not captured by the AlloyLogger library.";

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
const section = (name) => console.log(`\n${name}`);

const def = await loadRobotDefinition('donna');
const findingIds = new Set(def.findings.map((f) => f.id));
const prose = {
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
  loadingLine: def.loadingCopy?.line,
  loadingCap: def.loadingCopy?.cap,
  eventsTitle: def.eventsSection?.title,
  eventsPreamble: def.eventsSection?.preamble,
};
def.suggested.forEach((q, i) => { prose[`suggested[${i}]`] = q; });
for (const entry of def.script) prose[`script.${entry.id}`] = entry.answer;
const numberWordProse = { ...prose };
for (const finding of def.findings) {
  numberWordProse[`finding.${finding.id}.title`] = finding.title;
  numberWordProse[`finding.${finding.id}.note`] = finding.note;
}
for (const channel of def.channels) {
  numberWordProse[`channel.${channel.path}.label`] = channel.label;
  numberWordProse[`channel.${channel.path}.note`] = channel.note;
  for (const field of channel.fields) {
    numberWordProse[`channel.${channel.path}.${field.key}.label`] = field.label;
    numberWordProse[`channel.${channel.path}.${field.key}.provenance`] = field.provenance?.note;
  }
}

const PHRASE_BINDINGS = [
  { surface: 'tagline', phrase: /falls,\s+\w+\s+recoveries/i, claims: ['fallCount', 'recoveryCount'] },
  { surface: 'context.label', phrase: /falls,\s+\w+\s+recoveries/i, claims: ['fallCount', 'recoveryCount'] },
  { surface: 'loadingCap', phrase: /telemetry channels/i, claims: ['channelCount'] },
  { surface: 'script.speak-lines', phrase: /utterances in this half, \w+ distinct lines/i, claims: ['utteranceCount', 'distinctSpeakLineCount'] },
  { surface: 'script.falls-and-recoveries', phrase: /Peak acceleration magnitude across the \w+ impacts/i, claims: ['fallCount'] },
];

const NUMBER_WORD_VALUES = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);
const NUMBER_WORD_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;

section('1. matchers');
for (const entry of def.script) {
  for (const matcher of entry.matchers) {
    const hit = matchEntry(def.script, matcher);
    ok(hit === entry, `matcher "${matcher}" resolves to ${entry.id} (got ${hit && hit.id})`);
  }
}
{
  const natural = {
    'falls-and-recoveries': 'How many times did Donna fall in this match, and did she get up?',
    'show-the-fall': 'Show me the first fall.',
    'battery-sag': 'Did the battery cause the falls?',
    'servo-health': 'How hot did the servos get?',
    'how-log': 'How do I log this from my own robot?',
    'speak-lines': 'What did Donna say after the falls?',
  };
  eq(Object.keys(natural).length, def.script.length, 'every scripted entry has a natural phrasing');
  for (const [id, q] of Object.entries(natural)) {
    const hit = matchEntry(def.script, q);
    eq(hit && hit.id, id, `"${q}" routes to ${id}`);
  }
  eq(matchEntry(def.script, def.firstQuestion)?.id, 'falls-and-recoveries', 'the opener routes to the fall answer');
  for (const q of def.suggested) ok(!!matchEntry(def.script, q), `suggested question resolves: "${q}"`);
}

section('2. evidence');
for (const entry of def.script) {
  for (const id of entry.evidence || []) ok(findingIds.has(id), `${entry.id}: evidence ${id} exists`);
  for (const match of entry.answer.matchAll(/\{\{ev:([a-z0-9_-]+)\}\}/gi)) {
    ok(findingIds.has(match[1]), `${entry.id}: token ${match[1]} exists`);
    ok((entry.evidence || []).includes(match[1]), `${entry.id}: token ${match[1]} is declared in evidence[]`);
  }
}
{
  const cited = new Set(def.script.flatMap((entry) => entry.evidence || []));
  for (const id of findingIds) ok(cited.has(id), `finding ${id} is reachable from scripted copy`);
}

section('3. answer format and dashes');
for (const entry of def.script) {
  const verdict = entry.answer.split('\n')[0].trim();
  ok(verdict.split(/\s+/).length <= 20, `${entry.id}: verdict is at most 20 words`);
  ok(/[.!?]$/.test(verdict), `${entry.id}: verdict is a sentence`);
  const rows = entry.answer.split('\n').filter((line) => line.trim().startsWith('|'));
  for (const row of rows) {
    const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    eq(cells.length, 2, `${entry.id}: table row has two columns`);
  }
}
{
  const text = JSON.stringify(prose);
  ok(!text.includes(String.fromCharCode(0x2014)), 'no em dash in Donna copy');
  ok(!text.includes(String.fromCharCode(0x2013)), 'no en dash in Donna copy');
}

section('4. frozen disclosure surfaces');
{
  eq(def.firstQuestion, 'How many times did Donna fall in this match, and did she get up?', 'firstQuestion is frozen');
  eq(def.chatProvenance, CHAT_PROVENANCE, 'chatProvenance is frozen');
  eq(def.loadingCopy?.line, 'Loading the recorded mission.', 'loading line is frozen');
  eq(
    def.loadingCopy?.cap,
    'Recorded onboard at a real RoboCup match. Six telemetry channels and the full-body replay, decoded in your browser.',
    'loading cap is frozen',
  );
  ok(def.context.provenance.startsWith(ATTRIBUTION), 'context provenance begins with the attribution verbatim');
  ok(def.context.provenance.includes(ATTRIBUTION), 'context provenance carries the attribution verbatim');
  for (const [surface, text] of [
    ['context.provenance', def.context.provenance],
    ['chatProvenance', def.chatProvenance],
  ]) {
    ok(/ROS 2|rosbag2/i.test(text), `${surface}: names the onboard ROS 2 recording path`);
    ok(/offline/i.test(text) && /convert/i.test(text), `${surface}: names the offline conversion`);
    ok(/replay/i.test(text), `${surface}: says the result is replayed here`);
  }
  for (const token of [
    'DERIVED_MAGNITUDE+RESAMPLED_20HZ',
    'DERIVED_DIAG_AGGREGATE+RESAMPLED_2HZ',
    'DERIVED_RATIO+RESAMPLED_2HZ',
  ]) {
    ok(def.context.provenance.includes(token), `context.provenance names ${token}`);
  }
  const html = await readFile(path.join(HERE, '..', '..', '..', 'index.html'), 'utf8');
  ok(html.includes('<h1>Replay a mission.</h1>'), 'global headline is frozen');
  ok(html.includes(FOOTER), 'global footer is frozen');
  const chat = await readFile(path.join(HERE, '..', '..', 'core', 'chat.js'), 'utf8');
  ok(/robotDef\.chatProvenance/.test(chat), 'chat.js renders def.chatProvenance');
}

section('5. banned product claims');
{
  const claimsCapture = /\b(AlloyLogger(?: Arduino)? library|the library)\b[^.?!]{0,100}\b(captured|recorded|logged this|produced|ingested)\b|\b(captured|recorded|logged this|produced|ingested)\b[^.?!]{0,100}\b(AlloyLogger(?: Arduino)? library|the library)\b/i;
  const claimsPipeline = /\bAlloyLogger(?:'s)?(?: production)? pipeline\b[^.?!]{0,100}\b(ingested|produced|converted|captured|recorded)\b|\b(ingested|produced|converted|captured|recorded)\b[^.?!]{0,100}\bAlloyLogger(?:'s)?(?: production)? pipeline\b/i;
  const negated = /\b(no|not|never|did not|didn't|was not|wasn't|is not|isn't)\b/i;
  for (const [where, text] of Object.entries(prose)) {
    for (const sentence of String(text).split(/(?<=[.!?])\s+|\n/)) {
      for (const re of [claimsCapture, claimsPipeline]) {
        const hit = re.exec(sentence);
        if (hit) ok(negated.test(sentence), `${where}: product capture/ingest wording is explicitly negated: "${sentence.trim()}"`);
      }
    }
  }
  const how = def.script.find((entry) => entry.id === 'how-log')?.answer || '';
  ok(/would look like this|comparable fields|your own robot/i.test(how), 'logging answer is framed as how a visitor would log comparable fields');
  ok(/nothing on this page came out of an `alloy\.log\(\)` call/i.test(how), 'logging answer carries the honest inversion');
}

section('6. phrase bindings and numbers');
{
  const first = def.script.find((entry) => entry.id === 'falls-and-recoveries')?.answer || '';
  const battery = def.script.find((entry) => entry.id === 'battery-sag')?.answer || '';
  ok(first.startsWith(`${C.text('fallCount')} times, and she got up after every one.`), 'fall answer opens on the ledger fall count');
  ok(first.includes(`All ${C.text('recoveryCount')} land inside ${C.text('recoveryCeilingS')} s.`), 'fall answer binds every recovery to the measured ceiling');
  ok(C.value('recoveryCeilingS') < 6.6, 'the measured 6.5 s ceiling proves every recovery was under 6.6 s');
  ok(battery.includes(`${C.text('undervoltageCount')}`) && battery.includes(`${C.text('minBusVoltageV')} V`), 'battery answer binds count and minimum voltage');
  ok(/correlation inside one match log/i.test(battery), 'battery answer labels the relationship as correlation');
  ok(/does not establish battery sag as the cause/i.test(battery), 'battery answer rejects a diagnosed cause');

  for (const binding of PHRASE_BINDINGS) {
    const surfaceText = String(numberWordProse[binding.surface] || '');
    ok(binding.phrase.test(surfaceText), `${binding.surface}: phrase binding resolves on the rendered surface`);
    for (const claimName of binding.claims) {
      ok(
        Object.hasOwn(C.DATA_CLAIMS, claimName) && Number.isFinite(C.value(claimName)),
        `${binding.surface}: phrase binding resolves claim ${claimName}`,
      );
    }
  }

  const allowedNumbers = C.allowedNumbers();
  const allowedTexts = C.allowedTexts();
  for (const claim of Object.values(C.DATA_CLAIMS)) {
    if (typeof claim.eventId === 'number') allowedNumbers.add(claim.eventId);
  }
  const identifiers = [
    'RoboCup German Open 2025', 'ROS 2', '2v2', 'm/s^2',
    ...def.channels.flatMap((ch) => [
      ch.path,
      ...ch.fields.flatMap((field) => [field.key, field.provenance?.transform || '']),
    ]),
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  const stripIdentifiers = (text) => identifiers.reduce((out, id) => out.split(id).join(' '), text);
  const bad = [];
  let total = 0;
  for (const [where, text] of Object.entries(prose)) {
    const withoutCode = String(text).replace(/```[\s\S]*?```/g, ' ');
    const stripped = stripIdentifiers(withoutCode);
    for (const match of stripped.matchAll(/-?\d+(?:\.\d+)?/g)) {
      total++;
      if (allowedTexts.has(match[0]) || allowedNumbers.has(Number(match[0]))) continue;
      bad.push(`${where}: ${match[0]}`);
    }
  }
  const badWords = [];
  let wordTotal = 0;
  for (const [where, text] of Object.entries(numberWordProse)) {
    const withoutCode = String(text).replace(/```[\s\S]*?```/g, ' ');
    const stripped = stripIdentifiers(withoutCode);
    for (const sentence of stripped.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean)) {
      const bindings = PHRASE_BINDINGS.filter(
        (binding) => binding.surface === where && binding.phrase.test(sentence),
      );
      if (!bindings.length) continue;
      const claimNames = new Set(bindings.flatMap((binding) => binding.claims));
      NUMBER_WORD_RE.lastIndex = 0;
      for (const match of sentence.matchAll(NUMBER_WORD_RE)) {
        wordTotal++;
        const value = NUMBER_WORD_VALUES.get(match[0].toLocaleLowerCase('en-US'));
        const bound = [...claimNames].some((claimName) => C.value(claimName) === value);
        if (!bound) {
          badWords.push(
            `${where}: ${match[0]}=${value} is not bound to a matching claim in ${[...claimNames].join(',')}`,
          );
        }
      }
    }
  }
  eq(bad.length, 0, `every numeric token in visitor copy is ledger-backed: ${bad.slice(0, 8).join(' | ')}`);
  ok(total > 25, `the numeric scan covered ${total} tokens`);
  eq(
    badWords.length,
    0,
    `every zero-to-twelve number word in a load-bearing sentence is phrase-bound: ${badWords.join(' | ')}`,
  );
  ok(wordTotal >= 8, `the phrase-bound number-word scan covered ${wordTotal} tokens`);
}

section('7. lazy contract and hero');
{
  eq(def.id, 'donna', 'registry id');
  eq(def.duration, 306, 'full duration');
  ok(typeof def.loadSceneData === 'function', 'loadSceneData exists');
  ok(typeof def.isSceneDataLoaded === 'function', 'isSceneDataLoaded exists');
  ok(typeof def.getSceneData === 'function', 'getSceneData exists');
  ok(typeof def.eventLines === 'function', 'eventLines exists');
  ok(def.previewData && typeof def.previewData === 'object', 'preview data decodes at import');
  eq(def.heroTime(), 240.3, 'heroTime is frozen');
  const window = def.previewData.meta.window;
  ok(def.heroTime() > window[0] && def.heroTime() < window[1], `hero is strictly inside ${window[0]}..${window[1]}`);
  const src = await readFile(path.join(HERE, '..', 'donna', 'script.js'), 'utf8');
  ok(/^import \{ buildScene \} from '\.\/scene\.js';$/m.test(src), 'scene import remains byte-exact for build-facts');
  ok(src.includes(`ball visible at ${C.text('heroBallDistM')} m relative to Donna`), 'hero copy binds the recomputed Donna-relative ball distance');
  eq(def.factsSeriesPoints, 48, 'Donna pins the facts table below the size ceiling');
}

section('8. eventsSection extension');
{
  await def.loadSceneData();
  const donnaSection = renderEventsSection(def);
  ok(donnaSection.startsWith('## Match and onboard events\n\n'), 'Donna owns the event section title');
  ok(donnaSection.includes("These are the robot's own recorded match and diagnostic events."), 'Donna owns the event preamble');

  const battle = await loadRobotDefinition('battle');
  await battle.loadSceneData();
  const rows = battle.eventLines();
  const legacyFmt = (value) => {
    if (Number.isInteger(value)) return String(value);
    const abs = Math.abs(value);
    if (abs >= 10) return value.toFixed(1);
    if (abs >= 1) return value.toFixed(2);
    return value.toFixed(3);
  };
  const legacy = [
    '## Round events',
    '',
    'Referee-visible events from the mission event ledger, in order. These are the only event timestamps you may cite; the charts do not carry them.',
    '',
    ...rows.map((row) => `- t=${legacyFmt(row.t)} s \`${row.source}\` ${row.kind}: ${row.detail}`),
    '',
  ].join('\n');
  eq(renderEventsSection(battle), legacy, 'battle rendered events section is byte-identical to the legacy default');

  const sbr = await loadRobotDefinition('sbr');
  eq(renderEventsSection(sbr), '', 'a mission without eventLines emits no event section');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
