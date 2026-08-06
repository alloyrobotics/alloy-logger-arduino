// donna-script.test.mjs - integration contract for the Donna, Jack and Rory RobotDefinition.
//
// The three robots recorded independently onboard with rosbag2. These checks keep the frozen copy,
// role split, claim bindings, old-way sample and lazy replay contract honest.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { eventsSection as renderEventsSection, loadRobotDefinition } from '../../../../worker/build-facts.mjs';
import { matchEntry } from '../../core/matcher.js';
import * as C from '../donna/claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATTRIBUTION =
  'Three Wolfgang-OP humanoids of the Hamburg Bit-Bots (Universitat Hamburg), recorded at RoboCup German Open 2025.';
const ROLE_SPLIT =
  'recorded independently on each robot by its onboard rosbag2 logger; converted offline for this demo; replayed here.';
const FOOTER =
  "Two synthetic missions, one real match replay with planted fault overlays, and one real match replayed from three robots' onboard logs. Runs entirely in your browser.";

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
const findingIds = new Set(def.findings.map((finding) => finding.id));
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
def.suggested.forEach((question, index) => { prose[`suggested[${index}]`] = question; });
for (const entry of def.script) prose[`script.${entry.id}`] = entry.answer;
const numberWordProse = { ...prose };
for (const finding of def.findings) {
  numberWordProse[`finding.${finding.id}.title`] = finding.title;
  numberWordProse[`finding.${finding.id}.note`] = finding.note;
}

const PHRASE_BINDINGS = [
  { surface: 'tagline', phrase: /One match/i, claims: ['oneMatchWord'] },
  { surface: 'tagline', phrase: /Three onboard logs/i, claims: ['threeLogsWord'] },
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
    'jack-falls': 'How many times did Jack fall, and did Donna or Rory fall too?',
    'show-jack-fall': 'Show me the last Jack fall.',
    'three-logs-and-charts': 'Which robot produced the charts?',
    'penalty-traffic': 'What happened during the penalties?',
    'added-time-finish': 'How did the match finish?',
    'how-log': 'How do I log this from my own robot?',
  };
  eq(Object.keys(natural).length, def.script.length, 'every scripted entry has a natural phrasing');
  for (const [id, question] of Object.entries(natural)) {
    const hit = matchEntry(def.script, question);
    eq(hit && hit.id, id, `"${question}" routes to ${id}`);
  }
  eq(matchEntry(def.script, def.firstQuestion)?.id, 'jack-falls', 'the opener routes to Jack falls');
  for (const question of def.suggested) ok(!!matchEntry(def.script, question), `suggested question resolves: "${question}"`);
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

section('4. frozen disclosure and picker surfaces');
{
  eq(def.name, 'Donna, Jack & Rory', 'card title is frozen');
  eq(def.firstQuestion, 'How many times did Jack fall, and did Donna or Rory fall too?', 'firstQuestion is frozen');
  eq(def.loadingCopy?.line, 'Loading the recorded mission.', 'loading line is frozen');
  // The picker framing override, frozen, and it carries settings for TWO surfaces.
  //
  // `solo` is the picker CARD: it used to be framed by the envCull/envRadius pair alone, which kept
  // all three preview robots in shot and produced a card of three specks on a pitch. The card is now
  // a thumbnail of ONE machine, so the override names Donna's own torso node and the solve hides
  // everything else - the torso and not the `:robot` group, because the group also carries the name
  // tag that floats half a metre over her head.
  //
  // `envCull`/`envRadius` are the brief's HERO, which is a whole panel rather than a stamp and wants
  // all three bodies. `stage3d.fitOrbit` reads `solo`; `context.js` does not pass it, so the hero
  // still runs the heuristic cull and these are the values that keep it framed. They are live, not
  // leftovers: dropping them is the empty-card regression this assertion has always guarded, just
  // moved one surface over.
  ok(
    isDeepStrictEqual(def.preview, { solo: 'donna:torso', envCull: 0.6, envRadius: 0.5, distScale: 0.55 }),
    'preview framing override is frozen on the one-robot solo plus the hero cull',
  );
  ok(def.context.provenance.startsWith(ATTRIBUTION), 'context provenance begins with the attribution verbatim');
  for (const [surface, text] of [
    ['context.provenance', def.context.provenance],
    ['chatProvenance', def.chatProvenance],
  ]) {
    ok(text.includes(ROLE_SPLIT), `${surface}: carries the frozen role split verbatim`);
    ok(/AlloyLogger Arduino library did not capture/i.test(text), `${surface}: negates library capture`);
    ok(/no AlloyLogger production pipeline ingested or produced/i.test(text), `${surface}: negates product pipeline ingest`);
  }
  for (const token of [
    'DERIVED_MAGNITUDE+RESAMPLED_NEAREST_20HZ',
    'DERIVED_DIAGNOSTIC_AGGREGATE+ZOH_2HZ',
    'DERIVED_RATIO+RESAMPLED_NEAREST_2HZ',
  ]) {
    ok(def.context.provenance.includes(token), `context.provenance names ${token}`);
  }
  const html = await readFile(path.join(HERE, '..', '..', '..', 'index.html'), 'utf8');
  ok(html.includes('id="robot-grid"'), 'global mission library mount is present');
  // ROUND 3 removed the mission-library footer (UX wall, "ML-footer"). Every claim it made about
  // this mission is asserted above against `context.provenance` and `chatProvenance`, which are
  // the surfaces a donna visitor is shown; the frozen string is now pinned as ABSENT so it cannot
  // return in a weaker form.
  ok(!html.includes(FOOTER) && !/class="pick-foot"/.test(html), 'the global picker footer is gone');
  const registry = await readFile(path.join(HERE, '..', 'index.js'), 'utf8');
  ok(/donna:\s*`[^`]*data-figure="donna"[^`]*data-figure="jack"[^`]*data-figure="rory"[^`]*`/s.test(registry), 'Donna picker fallback icon carries three labelled figure groups');
}

section('5. banned product claims and stale v1 story');
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
  ok(/did not come from an `alloy\.log\(\)` call/i.test(how), 'logging answer carries the honest inversion');
  const text = JSON.stringify(prose);
  for (const stale of ['six falls', 'six recoveries', 'battery sag', 'servo clamp', 'What did Donna say']) {
    ok(!text.toLowerCase().includes(stale.toLowerCase()), `stale v1 story is absent: ${stale}`);
  }
}

section('6. phrase bindings and numbers');
{
  const jack = def.script.find((entry) => entry.id === 'jack-falls')?.answer || '';
  const logs = def.script.find((entry) => entry.id === 'three-logs-and-charts')?.answer || '';
  ok(jack.startsWith(`Jack fell ${C.text('jackFallCount')} times; Donna and Rory did not fall.`), 'Jack answer opens on all three ledger counts');
  ok(jack.includes('This was definitely a foul.'), 'Jack answer preserves the recorded foul line verbatim');
  ok(logs.startsWith("The charts are Donna's; the replay combines three onboard logs."), 'chart-source answer names Donna as chart protagonist');
  ok(logs.includes(`Donna ${C.text('donnaQueueFull')}, Jack ${C.text('jackQueueFull')}, Rory ${C.text('roryQueueFull')}`), 'three-log answer binds queue counts');

  for (const binding of PHRASE_BINDINGS) {
    const surfaceText = String(numberWordProse[binding.surface] || '');
    ok(binding.phrase.test(surfaceText), `${binding.surface}: phrase binding resolves on the rendered surface`);
    for (const claimName of binding.claims) {
      ok(Object.hasOwn(C.DATA_CLAIMS, claimName) && Number.isFinite(C.value(claimName)), `${binding.surface}: phrase binding resolves claim ${claimName}`);
    }
  }

  const allowedNumbers = C.allowedNumbers();
  const allowedTexts = C.allowedTexts();
  const identifiers = [
    'RoboCup German Open 2025', 'ROS 2', 'rosbag2', 'ESP32', 'm/s^2',
    ...def.channels.flatMap((channel) => [
      channel.path,
      ...channel.fields.flatMap((field) => [field.key, field.provenance?.transform || '']),
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
    const bindings = PHRASE_BINDINGS.filter((binding) => binding.surface === where && binding.phrase.test(String(text)));
    if (!bindings.length) continue;
    const claimNames = new Set(bindings.flatMap((binding) => binding.claims));
    for (const match of String(text).matchAll(NUMBER_WORD_RE)) {
      wordTotal++;
      const value = NUMBER_WORD_VALUES.get(match[0].toLowerCase());
      const bound = [...claimNames].some((claimName) => C.value(claimName) === value);
      if (!bound) badWords.push(`${where}: ${match[0]}=${value}`);
    }
  }
  eq(bad.length, 0, `every numeric token in visitor copy is ledger-backed: ${bad.slice(0, 8).join(' | ')}`);
  ok(total > 20, `the numeric scan covered ${total} tokens`);
  eq(badWords.length, 0, `load-bearing number words are phrase-bound: ${badWords.join(' | ')}`);
  ok(wordTotal >= 2, `the phrase-bound number-word scan covered ${wordTotal} tokens`);
}

section('7. old-way sample and lazy contract');
{
  await def.loadSceneData();
  const data = def.buildData();
  const expectedDatapoints = def.channels.reduce(
    (sum, channel) => sum + data[channel.path].t.length * channel.fields.length,
    0,
  );
  eq(expectedDatapoints, 28515, 'new-window row-times-field count is frozen');
  eq(def.context.datapoints, expectedDatapoints, 'authored datapoint count matches the decoded arrays');
  eq(def.context.oldwaySample.length, 40, 'old-way sample is exactly 40 lines');
  let previousT = -Infinity;
  for (const [lineIndex, line] of def.context.oldwaySample.entries()) {
    const match = line.match(/^(\d+\.\d{3})\s+(\/\w+)\s+(.+)$/);
    ok(!!match, `old-way line ${lineIndex}: parseable authored format`);
    if (!match) continue;
    const t = Number(match[1]);
    ok(t >= previousT, `old-way line ${lineIndex}: time ordered`);
    previousT = t;
    const channel = def.channels.find((candidate) => candidate.path === match[2]);
    ok(!!channel, `old-way line ${lineIndex}: known channel ${match[2]}`);
    const block = data[match[2]];
    const sampleIndex = [...block.t].findIndex((value) => Math.abs(value - t) < 1e-9);
    ok(sampleIndex >= 0, `old-way line ${lineIndex}: timestamp exists in decoded series`);
    for (const token of match[3].split(/\s+/)) {
      const [key, rendered] = token.split('=');
      const field = channel?.fields.find((candidate) => candidate.key === key);
      ok(!!field, `old-way line ${lineIndex}: known field ${key}`);
      if (!field || sampleIndex < 0) continue;
      const mask = field.mask && block[field.mask];
      if (rendered === 'null') {
        ok(!!mask && !mask[sampleIndex], `old-way line ${lineIndex}: null is masked absence`);
      } else {
        const decimals = (rendered.split('.')[1] || '').length;
        eq(Number(rendered).toFixed(decimals), Number(block[key][sampleIndex]).toFixed(decimals), `old-way line ${lineIndex}: ${key} sample exact`);
      }
    }
  }
  ok(def.context.oldwaySample.some((line) => line.includes('ownScore=4')), 'old-way slice contains pre-goal score');
  ok(def.context.oldwaySample.some((line) => line.includes('ownScore=5')), 'old-way slice contains post-goal score');

  eq(def.duration, 250, 'full duration');
  eq(def.factsSeriesPoints, 53, 'Donna uses the six-channel default facts density');
  eq(def.heroTime(), 187.6, 'heroTime is frozen');
  const window = def.previewData.meta.window;
  ok(def.heroTime() > window[0] && def.heroTime() < window[1], `hero is strictly inside ${window[0]}..${window[1]}`);
  ok(typeof def.loadSceneData === 'function' && typeof def.getSceneData === 'function', 'lazy scene-data ABI exists');
  const source = await readFile(path.join(HERE, '..', 'donna', 'script.js'), 'utf8');
  ok(/^import \{ buildScene \} from '\.\/scene\.js';$/m.test(source), 'scene import remains byte-exact for build-facts');
}

section('8. eventsSection extension');
{
  const donnaSection = renderEventsSection(def);
  ok(donnaSection.startsWith('## Aligned match and onboard events\n\n'), 'Donna owns the aligned event title');
  ok(donnaSection.includes('Donna-clock events and window summaries from Donna, Jack and Rory'), 'Donna owns the three-robot event preamble');

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
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
