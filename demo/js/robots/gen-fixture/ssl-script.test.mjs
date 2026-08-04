// ssl-script.test.mjs - self-test for demo/js/robots/ssl/script.js, the RobotDefinition.
//
//   node demo/js/robots/gen-fixture/ssl-script.test.mjs
//
// This directory is in .assetsignore, so nothing here is ever served. The def is loaded through
// build-facts.mjs's own loader, which stubs the scene.js import: that is the same code path the
// facts builder uses, so a change that breaks the builder breaks this test first.
//
// What it proves:
//   1  every scripted entry is reachable from its own matchers, and nothing shadows anything
//   2  the firstQuestion and every suggested question resolve to an entry
//   3  every evidence id and every {{ev:}} token names a finding this robot owns
//   4  the answers hold to the house format (2 column tables, short verdict line)
//   5  no em dash anywhere in the def's copy
//   6  the lazy-payload contract is complete: previewData + loadSceneData + isSceneDataLoaded
//      + getSceneData, and the scene-import line build-facts greps for is intact
//   7  the keeper the copy names IS the keeper `TeamInfo.goalkeeper` carries, so the prose and
//      the data-derived HUD chip cannot drift apart across a re-export
//   8  NON-CAUSALITY. No answer lets a synthesized fault explain something the real match did,
//      the opener does not presuppose one, and every synthetic entry carries its honesty line
//   9  the four-surface disclosure is really on all four surfaces, including the picker footer and
//      the client-rendered provenance line above the composer

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRobotDefinition } from '../../../../worker/build-facts.mjs';
import { matchEntry } from '../../core/matcher.js';

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
const section = (n) => console.log(`\n${n}`);

const def = await loadRobotDefinition('ssl');
const findingIds = new Set(def.findings.map((f) => f.id));

// ---------------------------------------------------------------- 1. matchers

section('matchers');
for (const entry of def.script) {
  for (const m of entry.matchers) {
    const hit = matchEntry(def.script, m);
    ok(hit === entry, `matcher "${m}" resolves to its own entry (got ${hit && hit.id}, want ${entry.id})`);
  }
}

// ---------------------------------------------------------------- 2. authored questions

section('authored questions');
{
  const first = matchEntry(def.script, def.firstQuestion);
  ok(!!first, `firstQuestion resolves to an entry`);
  ok(first && (first.evidence || []).length > 0, 'the opener resolves to an evidence-bearing entry');
  for (const q of def.suggested) {
    ok(!!matchEntry(def.script, q), `suggested question resolves: "${q}"`);
  }
  const reached = new Set(def.script.map((e) => matchEntry(def.script, e.matchers.join(' ')).id));
  ok(reached.size === def.script.length, 'every entry is the best match for its own matcher set');
}

// ---------------------------------------------------------------- 3. evidence ids

section('evidence');
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
  for (const f of def.findings) ok(cited.has(f.id), `finding \`${f.id}\` is reachable from a scripted answer`);
}

// ---------------------------------------------------------------- 4. house format

section('answer format');
for (const entry of def.script) {
  const lines = entry.answer.split('\n');
  const verdict = lines[0].trim();
  ok(verdict.split(/\s+/).length <= 12, `${entry.id}: verdict line is <= 12 words (${verdict.split(/\s+/).length})`);
  ok(/[.!?]$/.test(verdict), `${entry.id}: verdict line is a sentence`);
  const rows = lines.filter((l) => l.trim().startsWith('|'));
  for (const row of rows) {
    const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    ok(cells.length === 2, `${entry.id}: table row has exactly 2 columns: ${row.trim().slice(0, 60)}`);
  }
  ok(rows.length >= 3, `${entry.id}: has a mini table`);
}

// ---------------------------------------------------------------- 5. em dashes

section('copy');
{
  const copy = JSON.stringify({
    name: def.name,
    device: def.device,
    tagline: def.tagline,
    context: def.context,
    firstQuestion: def.firstQuestion,
    suggested: def.suggested,
    script: def.script,
    findings: def.findings,
    channels: def.channels,
  });
  ok(!copy.includes('—'), 'no em dash anywhere in the def');
  ok(!copy.includes('–'), 'no en dash anywhere in the def');
  ok(typeof def.context.provenance === 'string' && def.context.provenance.length > 80,
    'context.provenance carries the honesty line the brief screen renders');
  ok(/synthes/i.test(def.context.provenance), 'the provenance line says the telemetry is synthesized');
  const synthetic = def.script.filter((e) => /kicker|radio|dribbler/.test(e.id));
  for (const e of synthetic) {
    ok(/synthetic overlay/i.test(e.answer), `${e.id}: the answer discloses the synthetic overlay itself`);
  }
}

// ---------------------------------------------------------------- 8. non-causality

// The dataset's whole honesty argument is that a SYNTHESIZED fault is anchored to real events by
// CONSTRUCTION and therefore explains none of them. Copy is where that argument gets lost, so the
// bans are mechanical.
section('non-causality');
{
  const synthetic = def.script.filter((e) => /kicker|radio|dribbler/.test(e.id));
  ok(synthetic.length === 3, 'the three synthesized-fault entries are found by id');

  // Phrases that assert a synthesized fault had a real-world consequence. "worth taking" made the
  // modelled charge curve the reason real shots stopped; "what it cost" made a modelled cutout the
  // reason a real ball was lost and a real double touch was called.
  const BANNED = /worth taking|what it cost|which is why|and that is why|caused the|led to the/i;
  const allCopy = JSON.stringify({
    firstQuestion: def.firstQuestion,
    suggested: def.suggested,
    context: def.context,
    tagline: def.tagline,
    script: def.script,
    findings: def.findings,
  });
  ok(!BANNED.test(allCopy), `no synthetic-explains-real framing anywhere in the def`);
  for (const e of def.script) {
    const m = BANNED.exec(e.answer);
    ok(!m, `${e.id}: no banned causal framing${m ? ` ("${m[0]}")` : ''}`);
  }

  // The opener must not presuppose that the synthesized overlay drove real play. The old one
  // ("Why did bot 8 stop taking shots?") asked the analyst to explain a real behaviour with a
  // modelled channel before it had said a word.
  ok(
    !/stop(ped)? (taking|shooting)|stop taking shots|why did .* stop/i.test(def.firstQuestion),
    `firstQuestion does not ask why a real behaviour happened: "${def.firstQuestion}"`,
  );
  ok(
    /kicker|charge|bank/i.test(def.firstQuestion),
    'firstQuestion still lands on the synthesized channel it is about',
  );

  // Every synthetic entry says so IN ITS OWN BODY, because the scripted answers bypass the facts
  // pack entirely and a visitor may never see another surface.
  for (const e of synthetic) {
    ok(/synthetic overlay on real match motion/i.test(e.answer), `${e.id}: carries the honesty line`);
    const tail = e.answer.slice(e.answer.search(/synthetic overlay on real match motion/i));
    ok(tail.length > 60, `${e.id}: the honesty line says what is real and what is not, not just a label`);
  }

  // The one entry about a REAL event may not cite a synthesized finding as its cause.
  const goal = def.script.find((e) => e.id === 'goal-review');
  ok(!!goal, 'the goal entry exists');
  ok(
    /none of the fleet faults can be tied to this goal/i.test(goal.answer),
    'the goal answer states outright that no fleet fault is tied to it',
  );
  ok((goal.evidence || []).length === 0, 'the goal answer cites no fault evidence chip');
}

// ---------------------------------------------------------------- 9. disclosure surfaces

// The plan commits to the disclosure appearing on FOUR surfaces: picker copy, the brief's
// context.provenance, the scripted first answer, and the facts-pack preamble. Three of them are
// asserted here (the fourth is build-facts' own output); plus the standing line above the
// composer, which is the only one that does not depend on a model or a click.
section('disclosure surfaces');
{
  ok(
    typeof def.chatProvenance === 'string' && /synthetic overlay/i.test(def.chatProvenance),
    'the def ships a client-rendered chat provenance line',
  );
  ok(
    def.chatProvenance ===
      'Real match motion. Three faults are synthetic overlays; the bot 13 tracking loss is real.',
    'the provenance line is the authored copy, verbatim',
  );
  // The count is load-bearing: three faults are planted, the fourth finding is the log's own
  // tracking loss, and calling all four planted is the misstatement this assertion exists to stop.
  for (const surface of [def.tagline, def.chatProvenance, def.context.provenance]) {
    ok(
      !/\bfour\b[^.]{0,40}\b(planted|synthetic|synthesi[sz]ed)\b/i.test(surface) &&
        !/\b(planted|synthetic|synthesi[sz]ed)\b[^.]{0,40}\bfour\b/i.test(surface),
      `no disclosure surface calls four faults planted: "${surface}"`,
    );
  }
  ok(
    /three/i.test(def.tagline) && /real tracking loss/i.test(def.tagline),
    `the tagline separates the three planted faults from the real tracking loss: "${def.tagline}"`,
  );
  ok(
    /bot 13 tracking loss is the log's own data/.test(def.context.provenance),
    'the brief provenance attributes the bot 13 finding to the log, not to a planted overlay',
  );
  {
    const synth = def.findings.filter((f) => /synthesized/i.test(f.note || ''));
    const real = def.findings.filter((f) => /REAL DATA, no synthesis/i.test(f.note || ''));
    ok(synth.length === 3, `exactly three findings are synthesized (got ${synth.length})`);
    ok(real.length === 1, `exactly one finding is the log's own data (got ${real.length})`);
  }

  const html = await readFile(path.join(HERE, '..', '..', '..', 'index.html'), 'utf8');
  ok(
    html.includes(
      "Two synthetic missions, one real match replay with planted fault overlays, and one real match replayed from three robots' onboard logs. Runs entirely in your browser.",
    ),
    'the picker footer names the fault overlays as planted, verbatim',
  );
  const chat = await readFile(path.join(HERE, '..', '..', 'core', 'chat.js'), 'utf8');
  ok(
    /robotDef\.chatProvenance/.test(chat),
    'chat.js renders the line from the def rather than from a model answer',
  );

  // and the tagline no longer implies the faults belong to the real replay
  ok(!/buried faults/i.test(def.tagline), 'the card tagline does not call the faults buried in the match');
  ok(/planted/i.test(def.tagline), `the card tagline says the faults were planted: "${def.tagline}"`);

  // de-identification: the mission line describes the match generically
  ok(!/\bfinals?\b/i.test(JSON.stringify(def)), 'the word "final" appears nowhere in the def');
  ok(
    /professional Division A match/.test(def.context.mission),
    `the mission line is the generic description: "${def.context.mission}"`,
  );
}

// ---------------------------------------------------------------- 6. lazy payload contract

section('contract');
{
  ok(typeof def.loadSceneData === 'function', 'def.loadSceneData()');
  ok(typeof def.isSceneDataLoaded === 'function', 'def.isSceneDataLoaded()');
  ok(typeof def.getSceneData === 'function', 'def.getSceneData()');
  ok(def.previewData && Array.isArray(def.previewData.robots), 'def.previewData decoded at module scope');
  ok(def.isSceneDataLoaded() === false, 'the match payload is NOT loaded by importing the def');
  ok(def.getSceneData() === def.previewData, 'getSceneData() falls back to the preview slice');
  ok(def.rates && Object.keys(def.rates).length === def.channels.length, 'a cadence per channel');
  ok(typeof def.heroTime === 'function' && Number.isFinite(def.heroTime()), 'def.heroTime() resolves');
  const src = await readFile(path.join(HERE, '..', 'ssl', 'script.js'), 'utf8');
  ok(
    /^import \{ buildScene \} from '\.\/scene\.js';$/m.test(src),
    "the scene import line is verbatim what build-facts.mjs's stub regex matches",
  );
}

// ---------------------------------------------------------------- 7. keeper identity

// The scripted own-goal table names a keeper in prose. The HUD derives the same identity from
// `TeamInfo.goalkeeper`, and the game controller can move it mid-half, so the two MUST agree or a
// re-export would leave the copy asserting a keeper the strip contradicts. This is the check that
// makes the hardcoded sentence safe: it fails the moment the data disagrees with it.
section('keeper identity');
{
  const { META } = await import('../ssl/match-data.js');
  const claims = [];
  for (const entry of def.script) {
    for (const m of entry.answer.matchAll(/([A-Za-z]+) #(\d+), our keeper/g)) {
      claims.push({ entry: entry.id, team: m[1], id: Number(m[2]) });
    }
  }
  ok(claims.length > 0, 'the def makes a keeper claim the data can be held against');
  const states = META.referee.teamState || [];
  ok(states.length > 0, 'the referee track carries teamState samples');
  for (const c of claims) {
    const colour = Object.keys(META.teams).find(
      (k) => META.teams[k] && META.teams[k].shortName === c.team,
    );
    ok(!!colour, `${c.entry}: "${c.team}" is one of the renamed teams`);
    if (!colour) continue;
    const ids = [...new Set(states.map((s) => s[colour].goalkeeper))];
    ok(
      ids.length === 1 && ids[0] === c.id,
      `${c.entry}: "${c.team} #${c.id}, our keeper" matches TeamInfo.goalkeeper for every sample ` +
        `(got ${ids.join(',')})`,
    );
  }
  // And the HUD's own derivation is live rather than a literal: every sample of both teams has a
  // keeper id, so the chips can never be empty on this window.
  for (const colour of ['yellow', 'blue']) {
    ok(
      states.every((s) => Number.isInteger(s[colour].goalkeeper)),
      `${colour}: every teamState sample carries a goalkeeper id for the HUD chip`,
    );
    ok(
      states.every((s) => Number.isInteger(s[colour].timeouts)),
      `${colour}: every teamState sample carries a timeouts count for the HUD strip`,
    );
  }
}

// ---------------------------------------------------------------- 7b. the DECISIVE kick

// Keeper identity was the only thing this file held the goal answer to, and keeper identity is the
// half the game controller supplies. The other half is the TRACKER's, and the answer used to get it
// wrong in a way no identity check could see: it quoted #12's kick at 59.702 s, which is three
// seconds and two intervening touches before the ball crossed, and read as the shot that scored.
//
// So the assertion is chronological, not nominal. Whatever kick the copy narrates as the shot has
// to BE the last tracker kick before `tBallCrossing`. Note the trap this pins: there is another
// #12 kick at 62.7647 s, AFTER the crossing, whose speed is higher. A test that looked for "the
// fastest #12 kick near the goal" would have blessed the wrong one.
section('the decisive kick');
{
  const { META } = await import('../ssl/match-data.js');
  const goal = (META.referee.goals || [])[0];
  ok(!!goal && Number.isFinite(goal.tBallCrossing), 'the referee track carries the crossing time');

  const before = (META.kicks || []).filter((k) => k.t < goal.tBallCrossing);
  ok(before.length > 0, 'the tracker records kicks before the crossing');
  const decisive = before[before.length - 1];
  ok(
    Math.abs(decisive.t - 62.6897) < 5e-4 && decisive.robot.id === 12,
    `the last tracker kick before the crossing is #${decisive.robot.id} at ${decisive.t} s`,
  );

  // The trap, asserted rather than assumed: a later, faster kick by the same robot exists.
  const after = (META.kicks || []).filter((k) => k.t >= goal.tBallCrossing);
  ok(
    after.length > 0 && after[0].speed > decisive.speed,
    'a LATER kick by the same robot is faster, so "fastest nearby" would pick the wrong one',
  );

  const answer = def.script.find((e) => e.id === 'goal-review').answer;
  // Every time in the narration, to 2 dp, against the arrays.
  const want = [
    [`${decisive.t.toFixed(2)} s`, 'the decisive kick'],
    [`${decisive.speed.toFixed(2)} m/s`, "the decisive kick's speed"],
    [`${goal.tBallCrossing.toFixed(2)} s`, 'the crossing'],
    [`${goal.tAwarded.toFixed(2)} s`, 'the award after review'],
  ];
  for (const [text, what] of want) {
    ok(answer.includes(text), `the goal answer quotes ${what} as the arrays hold it: ${text}`);
  }
  // The intervening touches: the answer must not jump from the first kick straight to the goal.
  const between = before.filter((k) => k.t > 59.71 && k.t < decisive.t);
  ok(between.length === 2, `two tracker touches sit between the first kick and the shot (${between.length})`);
  for (const k of between) {
    ok(
      answer.includes(`${k.t.toFixed(2)} s`),
      `the goal answer narrates the intervening touch at ${k.t.toFixed(2)} s`,
    );
  }
  // ...and it says WHICH attribution is which, because the two disagree about who touched it last.
  ok(
    /tracker attribution/i.test(answer),
    "the goal answer labels the tracker attribution as the tracker's",
  );
  ok(
    /game controller/i.test(answer),
    'and names the game controller as the source of the last-touch call',
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
