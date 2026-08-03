// build-facts.mjs - generates the grounding facts pack the /demo/api/chat endpoint feeds Claude.
//
// The demo's telemetry is built deterministically in the browser from each robot's data.js
// (synthesized for the four canned missions; the SSL mission mixes real tracker/vision channels
// with synthesized overlays, per-field provenance tags tell them apart). This script runs those
// same generators in Node with the same seed app.js uses, then
// writes out what the model is allowed to know: mission metadata, per-field statistics,
// downsampled series, a dense excerpt around every finding window, and the hand-verified
// scripted analyses lifted verbatim out of script.js.
//
// Nothing here is hand-typed from memory. If a generator constant changes, re-run this and the
// answers change with it. That is the whole point: the model quotes numbers that are true of the
// arrays the page is actually plotting.
//
//   node worker/build-facts.mjs
//
// Output: worker/facts.generated.js (committed - the Worker imports it at build time).
//
// Running this file builds every canned robot in ROBOT_IDS. IMPORTING it gets the pure builders and
// writes nothing: the demo generator's runner snapshots this module into its own runtime/ and
// calls buildFacts() over a generated def, so a personalized mission is described to the
// analyst in exactly the format every canned mission is. One builder, one format, no second copy.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROBOTS_DIR = path.join(ROOT, 'demo', 'js', 'robots');
export const ROBOT_IDS = ['sbr', 'arm6', 'drone', 'rescue', 'ssl', 'battle', 'donna'];

/** How many points a whole-mission series is downsampled to. */
export const SERIES_POINTS = 80;
/** How many points the dense excerpt around a finding window gets. */
export const WINDOW_POINTS = 30;

// ---------------------------------------------------------------------------- loading

/**
 * script.js is the RobotDefinition (name, tagline, suggested questions, verified answers) but it
 * also imports scene.js, which imports three.js and does not load outside a browser. Rather than
 * duplicate the prose into this script - where it would drift - rewrite that one import in a
 * throwaway sibling module and import that. The temp file lives next to the original so its
 * relative './data.js' import still resolves.
 */
export async function loadRobotDefinition(id) {
  const dir = path.join(ROBOTS_DIR, id);
  const src = await readFile(path.join(dir, 'script.js'), 'utf8');
  const stubbed = src.replace(
    /^import\s+\{\s*buildScene\s*\}\s+from\s+'\.\/scene\.js';$/m,
    'const buildScene = null; // stubbed by build-facts.mjs',
  );
  if (stubbed === src) throw new Error(`${id}/script.js: could not stub the scene.js import`);

  const tmp = path.join(dir, `.facts-build-${process.pid}.mjs`);
  await writeFile(tmp, stubbed);
  try {
    return (await import(pathToFileURL(tmp).href)).default;
  } finally {
    await unlink(tmp);
  }
}

// ---------------------------------------------------------------------------- formatting

/** Trim a float to something readable without inventing precision. */
export function fmt(v) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export const fmtT = (t) => `${t.toFixed(2)}s`;

/** What a table cell says where a field has no reading. A word, never a number. */
export const ABSENT = 'absent';

/**
 * A field's presence mask, if it declares one and its channel block carries it.
 *
 * `mask: '<key>'` on a field def names a 0/1 array on the same block saying which samples carry a
 * reading; where it is 0 the stored value is filler an export wrote across an absence, and printing
 * it as a number tells the analyst a measurement was taken that never was. Optional and inert: a
 * def that declares none gets null here and its pack is byte-identical to before this existed.
 *
 * @param {object} block the channel's data block
 * @param {object} f the field def
 * @returns {ArrayLike<number>|null}
 */
export function maskFor(block, f) {
  if (!block || !f || !f.mask) return null;
  const m = block[f.mask];
  return m && (Array.isArray(m) || ArrayBuffer.isView(m)) ? m : null;
}

/** One table cell: the formatted number, or `absent` where the mask says there is no reading. */
const cell = (block, f, i) => {
  const m = maskFor(block, f);
  return m && !m[i] ? ABSENT : fmt(block[f.key][i]);
};

/** Evenly spaced indices across [lo, hi], inclusive of both ends. */
export function pickIndices(lo, hi, count) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const n = Math.min(count, span + 1);
  const out = [];
  for (let k = 0; k < n; k++) out.push(lo + Math.round((span * k) / (n - 1)));
  return [...new Set(out)];
}

/** First index whose time is >= s. */
export function indexAt(times, s) {
  for (let i = 0; i < times.length; i++) if (times[i] >= s) return i;
  return times.length - 1;
}

// ---------------------------------------------------------------------------- facts sections

/**
 * @param {ArrayLike<number>} series
 * @param {ArrayLike<number>} times
 * @param {ArrayLike<number>|null} [mask] optional presence mask. Samples whose mask entry is falsy
 *   are EXCLUDED: a field that is zero-filled where its sensor had nothing to report has no
 *   reading at those samples, and averaging the filler in states a measurement that was never made.
 */
export function statsFor(series, times, mask) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let minI = 0;
  let maxI = 0;
  let n = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (mask && !mask[i]) continue;
    if (!Number.isFinite(v)) continue;
    if (v < min) {
      min = v;
      minI = i;
    }
    if (v > max) {
      max = v;
      maxI = i;
    }
    sum += v;
    n++;
  }
  if (!n) return null;
  let iFirst = 0;
  let iLast = series.length - 1;
  if (mask) {
    while (iFirst < series.length && !mask[iFirst]) iFirst++;
    while (iLast >= 0 && !mask[iLast]) iLast--;
  }
  return {
    min,
    max,
    mean: sum / n,
    minT: times[minI],
    maxT: times[maxI],
    first: series[iFirst],
    last: series[iLast],
    n,
    total: series.length,
  };
}

/**
 * A field's two-dimensional provenance, if its def declares one: `origin` says where the number
 * came from (REAL_TRACKER, REAL_GAME_CONTROLLER, REAL_VISION, SYNTHETIC), `transform` says what was
 * done to it (WIRE, FIRMWARE_FLAG_DECODE, DERIVED_<X>, NONE). It is emitted so the analyst can
 * never present a synthesized channel as log ground truth. A def that declares none (the four
 * hand-written robots, every generated mission) emits nothing at all.
 */
function provenanceLine(f) {
  const p = f && f.provenance;
  if (!p || !p.origin) return null;
  const tail = p.note ? ` - ${p.note}` : '';
  return `- \`${f.key}\`: ${p.origin} / ${p.transform || 'NONE'}${tail}`;
}

export function channelSection(def, data) {
  const lines = [];
  for (const ch of def.channels) {
    const block = data[ch.path];
    if (!block) continue;
    const times = block.t;
    lines.push(`### ${ch.path} — ${times.length} samples, ${fmtT(times[0])} to ${fmtT(times[times.length - 1])}`);
    lines.push('');
    lines.push('| field | unit | first | last | min (at) | max (at) | mean |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    /** Absence notes raised by a zero-filled field, emitted under the table. */
    const absence = [];
    for (const f of ch.fields) {
      // A masked field has no reading where its mask is 0. Its statistics are computed over the
      // PRESENT samples only, and the absent fraction is stated on its own line rather than being
      // averaged into the numbers. One declaration, `mask` on the field def, drives this, the
      // series tables below and the chart - so the pack and the plot cannot disagree about which
      // samples are readings.
      const mask = maskFor(block, f);
      const s = statsFor(block[f.key] || [], times, mask);
      if (!s) continue;
      lines.push(
        `| ${f.key} | ${f.unit || '-'} | ${fmt(s.first)} | ${fmt(s.last)} | ` +
          `${fmt(s.min)} (${fmtT(s.minT)}) | ${fmt(s.max)} (${fmtT(s.maxT)}) | ${fmt(s.mean)} |`,
      );
      if (mask) {
        const absent = s.total - s.n;
        // WHY there is no reading comes from the field def (`maskNote`), because two masked fields
        // on one channel can be absent for two different reasons - /bot13/vision's `visibility` is
        // absent where the tracker had no frame, its `detections` where the cross-check holds no
        // count for the bin - and a single sentence for both states one of them wrongly.
        absence.push(
          `\`${f.key}\` has NO READING for ${absent} of ${s.total} samples ` +
            `(${fmt((100 * absent) / s.total)} % of the window): ` +
            `${f.maskNote || 'nothing was measured there'}. The row above is computed over the ` +
            `${s.n} samples that do carry a reading, and every table below writes \`${ABSENT}\` ` +
            `for the rest. There is no measured value at those instants - not a zero, not a low ` +
            `one - so do not quote the field's mean as a value over the whole window, and never ` +
            `describe an absent sample as a reading of any size.`,
        );
      }
    }
    if (absence.length) {
      lines.push('');
      lines.push(...absence);
    }
    const prov = ch.fields.map(provenanceLine).filter(Boolean);
    const cadence = def.rates && def.rates[ch.path] != null
      ? `cadence: ${fmt(def.rates[ch.path])} Hz` +
        (def.rateNotes && def.rateNotes[ch.path] ? ` (${def.rateNotes[ch.path]})` : '')
      : null;
    if (cadence || ch.note || prov.length) {
      lines.push('');
      if (cadence) lines.push(cadence);
      if (ch.note) lines.push(ch.note);
      if (prov.length) {
        lines.push('provenance, per field (origin / transform):');
        lines.push(...prov);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Where a mission's data came from, and which parts of it are synthesized. Emitted only for a def
 * that carries `context.provenance`, which is the same sentence the brief screen renders, so the
 * visitor and the analyst are told the same thing in the same words. Everything else, including all
 * four hand-written robots, emits nothing and its pack is byte-identical to before this existed.
 */
export function provenanceSection(def) {
  const p = def.context && def.context.provenance;
  const health = (def.findings || []).filter((f) => f && (f.healthState || f.healthStateNote));
  if (!p && !health.length) return '';
  const lines = ['## Where this data comes from', ''];
  if (p) {
    lines.push(String(p).trim());
    lines.push('');
    lines.push(
      'Say so when an answer leans on a synthesized channel. Never present one as something the ' +
        'log recorded, and never attach a synthesized fault to a real team or a real outcome.',
    );
    lines.push('');
    // A mission where EVERY field is synthetic gets the stronger standing rule: the reader of one
    // answer never saw the preamble, so each answer carries its own one-clause disclosure.
    const fields = (def.channels || []).flatMap((ch) => ch.fields || []);
    const allSynthetic =
      fields.length > 0 && fields.every((f) => f.provenance && f.provenance.origin === 'SYNTHETIC');
    if (allSynthetic) {
      lines.push(
        'Every channel in this mission is synthesized. Work one short clause into EVERY answer ' +
          "marking it as such (for example 'in this simulated round'), even when the question is " +
          'purely about the numbers.',
      );
      lines.push('');
    }
  }
  if (health.length) {
    lines.push(
      'Health state per finding. This is a demo-generated application-layer classification over ' +
        'the synthesized telemetry (modelled on how SSL teams classify robot health); not output ' +
        "from any real team's software.",
    );
    lines.push('');
    for (const f of health) {
      const note = f.healthStateNote ? ` (${f.healthStateNote})` : '';
      lines.push(`- \`${f.id}\`: ${f.healthState || 'none'}${note}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Typed round events, for a def that exposes `eventLines` (a function, callable only after
 * `loadSceneData()` resolved, which main() awaits before buildData). Fixed-format lines from the
 * mission's own event ledger: referee-visible state changes the charts cannot carry. Every other
 * def ships no hook and emits nothing, so its pack is byte-identical to before this existed.
 */
export function eventsSection(def) {
  if (typeof def.eventLines !== 'function') return '';
  const rows = def.eventLines() || [];
  if (!rows.length) return '';
  const owned = def.eventsSection || {};
  const title = owned.title || 'Round events';
  const preamble =
    owned.preamble ||
    'Referee-visible events from the mission event ledger, in order. These are the only event ' +
      'timestamps you may cite; the charts do not carry them.';
  const lines = [`## ${title}`, '', preamble, ''];
  for (const r of rows) lines.push(`- t=${fmt(r.t)} s \`${r.source}\` ${r.kind}: ${r.detail}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * A whole-mission table so the model can answer "what was X doing at t".
 *
 * The row budget is shared across the mission's channels rather than granted per channel: the pack
 * is a cached prompt prefix and this is its largest section, so a six-channel mission would
 * otherwise spend half the budget on a table every finding already excerpts densely. Four channels
 * or fewer keeps the full SERIES_POINTS, which is every mission that existed when this was written,
 * so their packs are unchanged.
 */
function seriesPointsFor(def) {
  // A def may pin its own row count (the battle pack's budget knob, fixed cut order in its plan);
  // clamped to the same floor and ceiling the formula has, and absent everywhere else.
  if (Number.isFinite(def.factsSeriesPoints)) {
    return Math.min(SERIES_POINTS, Math.max(40, Math.round(def.factsSeriesPoints)));
  }
  const n = (def.channels || []).length || 1;
  return Math.min(SERIES_POINTS, Math.max(40, Math.round(320 / n)));
}

export function seriesSection(def, data) {
  const lines = [];
  const points = seriesPointsFor(def);
  for (const ch of def.channels) {
    const block = data[ch.path];
    if (!block) continue;
    const times = block.t;
    const cols = ch.fields.filter((f) => Array.isArray(block[f.key]) || ArrayBuffer.isView(block[f.key]));
    if (!cols.length) continue;
    const keys = cols.map((f) => f.key);
    const idx = pickIndices(0, times.length - 1, points);
    lines.push(`### ${ch.path} sampled every ~${fmt((times[times.length - 1] - times[0]) / (idx.length - 1))} s`);
    lines.push('');
    lines.push(`| t (s) | ${keys.join(' | ')} |`);
    lines.push(`| --- | ${keys.map(() => '---').join(' | ')} |`);
    for (const i of idx) {
      lines.push(`| ${times[i].toFixed(1)} | ${cols.map((f) => cell(block, f, i)).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Dense excerpt across each finding's window, on the fields that finding focuses. */
export function findingsSection(def, data) {
  const lines = [];
  for (const f of def.findings) {
    const w = f.window || [0, def.duration];
    lines.push(`### ${f.id} — ${f.title}`);
    lines.push(
      `severity: ${f.severity || 'warn'} · window: ${fmtT(w[0])}–${fmtT(w[1])}` +
        (f.t != null ? ` · cited instant: ${fmtT(f.t)}` : '') +
        `\ncite this finding in an answer by writing {{ev:${f.id}}}`,
    );
    lines.push('');

    const focus = f.focus;
    const chDef = focus && (def.channels || []).find((c) => c.path === focus.channel);
    const block = focus && data[focus.channel];
    if (block) {
      const times = block.t;
      const lo = indexAt(times, w[0]);
      const hi = indexAt(times, w[1]);
      const cols = (focus.fields || [])
        .map((k) => (chDef && chDef.fields.find((x) => x.key === k)) || { key: k })
        .filter((x) => block[x.key]);
      if (cols.length) {
        // Uniform sampling can step right over the one sample the finding is about (the sbr I2C
        // spike is a single row). Union in the cited instant and each focused field's extremes
        // inside the window so the anomalous values are always in the table.
        const idx = new Set(pickIndices(lo, hi, WINDOW_POINTS));
        if (f.t != null) idx.add(indexAt(times, f.t));
        for (const col of cols) {
          const arr = block[col.key];
          // An absent sample is not a candidate extreme. The filler zero across a tracking loss
          // was winning "min" outright and pulling the row into the table as evidence of a low
          // reading, which is the opposite of what the absence means.
          const mask = maskFor(block, col);
          const usable = (i) => Number.isFinite(arr[i]) && (!mask || !!mask[i]);
          let minI = -1;
          let maxI = -1;
          for (let i = lo; i <= hi; i++) {
            if (!usable(i)) continue;
            if (minI < 0 || arr[i] < arr[minI]) minI = i;
            if (maxI < 0 || arr[i] > arr[maxI]) maxI = i;
          }
          if (minI >= 0) idx.add(minI);
          if (maxI >= 0) idx.add(maxI);
        }
        const keys = cols.map((c) => c.key);
        lines.push(`${focus.channel} across the window:`);
        lines.push('');
        lines.push(`| t (s) | ${keys.join(' | ')} |`);
        lines.push(`| --- | ${keys.map(() => '---').join(' | ')} |`);
        for (const i of [...idx].sort((a, b) => a - b)) {
          lines.push(`| ${times[i].toFixed(2)} | ${cols.map((c) => cell(block, c, i)).join(' | ')} |`);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

/**
 * The hand-verified answers, verbatim. These carry the analyst voice and the reasoning, which is
 * NOT always a causal story: the SSL mission's fault channels are a synthetic overlay on a real
 * match, so its answers state correlations by construction and say outright that the log cannot
 * establish why anything on the pitch happened. Whatever an answer claims here is what the model
 * is grounded on, so an answer that overclaimed would teach it to overclaim.
 */
export function analysesSection(def) {
  const lines = [];
  for (const entry of def.script || []) {
    lines.push(`### topic: ${entry.id}`);
    lines.push(`asked when the question is about: ${(entry.matchers || []).join(', ')}`);
    lines.push('');
    lines.push(entry.answer.trim());
    lines.push('');
  }
  // trailing blank line: this section is spliced straight in front of "## Findings"
  return lines.join('\n') + '\n';
}

/**
 * The ONLY product facts the analyst may state. Hand-written from README.md + the landing page;
 * everything else about Alloy gets deflected to usealloy.ai, because the model's ordinary
 * knowledge of "Alloy" is a different company.
 */
export const ABOUT_PRODUCT = `## About the product

The only product facts you may state; anything about Alloy this does not cover, point at usealloy.ai.

- AlloyLogger is a free, open-source (MIT) Arduino library for ESP32 that streams sensor and telemetry data straight to Alloy in about ten lines: you log name -> value pairs at the call site, the library RAM-buffers them and uploads in the background. No SD card, no flash wear, never blocks the control loop.
- Every power-on lands in Alloy as one replayable MCAP mission: replay it, scrub it, query it with SQL, ask about it the way this visitor is asking you.
- Alloy is the robotics data platform by Alloy Robotics: usealloy.ai. The library and docs: github.com/alloyrobotics/alloy-logger-arduino, or the Get started section on alloylogger.com.
- Pricing and accounts are not covered here: usealloy.ai.
- This page carries seven missions: five are synthetic, one is a real robot-soccer match replay with disclosed planted fault overlays, and one is a real match replayed from Donna, Jack and Rory's onboard logs. The match replay carries three planted onboard faults synthesized on top of the real tracking data, plus one finding that is the log's own data and not planted at all: the shared vision losing an opponent robot. The battle round is fully synthetic, generated against its competition's published rules manual. Donna, Jack and Rory recorded independently on each robot with rosbag2; the logs were converted offline into this demo's replay format and replayed here. Donna alone supplies the telemetry charts, while all three robots supply scene tracks and aligned events. The logs were not captured by the AlloyLogger library or ingested by an AlloyLogger production pipeline. No account or hardware is needed to explore any mission.
`;

/** One line per sibling so "what about the drone?" gets a useful pointer, not a shrug. */
export function otherMissionsSection(def, all) {
  const lines = ['## Other missions on this page', ''];
  lines.push('The visitor can switch demos with the robot picker (top of the page). You only see this mission.');
  for (const o of all) {
    if (o.id === def.id) continue;
    lines.push(`- ${o.name} (\`${o.id}\`): ${o.tagline}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The whole pack, in the order the analyst reads it.
 *
 * `opts` exists for the personalized demos the generator runner builds. Both fields default to
 * nothing, so the canned robots produce byte-identical output to before it existed (the
 * freshness gate in worker/README.md is what proves that).
 *
 * @param {object} def RobotDefinition, or the generated equivalent the runner assembles
 * @param {object} data `{ "<channel path>": { t, "<field key>": ... } }`
 * @param {Array<{id:string,name:string,tagline:string}>} all siblings, for the pointer section
 * @param {{ analystContext?: string, otherMissions?: string, aboutProduct?: string }} [opts]
 *   analystContext - an extra section inserted after the verified analyses. A generated mission
 *     has no hand-written analyses to lean on, so its def carries `facts_notes`: the generator's
 *     own account of the storyline, every number in it cross-checked by the validator.
 *   otherMissions - replaces the sibling list. A private mission has no siblings to enumerate.
 */
export function buildFacts(def, data, all, opts = {}) {
  const evidenceIds = def.findings.map((f) => f.id);
  // A mixed-rate mission has no single Hz to quote, and quoting one is a false statement about
  // every channel that does not run at it. Those defs carry `rates`, and their per-channel cadence
  // (with its source) is emitted in the channel section instead.
  const durationLine = def.rates
    ? `- log duration: ${fmt(def.duration)} s, mixed cadence (per channel, see Channel statistics)`
    : `- log duration: ${fmt(def.duration)} s at ${def.rate} Hz`;
  return `# Mission: ${def.name}

- robot id: \`${def.id}\`
- hardware: ${def.device}
- one-line summary: ${def.tagline}
${durationLine}
- valid evidence ids (the ONLY ids you may cite): ${evidenceIds.map((id) => `\`${id}\``).join(', ')}

${provenanceSection(def)}## Findings

${findingsSection(def, data)}
${eventsSection(def)}## Channel statistics

${channelSection(def, data)}
## Telemetry, sampled across the whole mission

${seriesSection(def, data)}
## Verified analyses

These were written and checked against this mission's own arrays: every number in them is a number
this log holds. When a visitor asks something one of them already answers, reuse its numbers and
its conclusion. Rephrase freely; do not contradict.

${analysesSection(def)}
${opts.analystContext ?? ''}${opts.otherMissions ?? otherMissionsSection(def, all)}
${opts.aboutProduct ?? ABOUT_PRODUCT}`;
}

// ---------------------------------------------------------------------------- main

async function main() {
  // seedFor is shared with app.js via prng.js: one definition, no silent drift.
  const { mulberry32, seedFor } = await import(
    pathToFileURL(path.join(ROOT, 'demo', 'js', 'core', 'prng.js')).href
  );

  const defs = [];
  for (const id of ROBOT_IDS) defs.push(await loadRobotDefinition(id));
  const siblings = defs.map((d) => ({ id: d.id, name: d.name, tagline: d.tagline }));

  const out = {};
  for (const def of defs) {
    const id = def.id;
    // A def whose channels are derived from a lazily loaded scene payload cannot build them until
    // that payload is in. Same ordering app.js's demo route uses, and the same tripwire guards it.
    if (typeof def.loadSceneData === 'function') await def.loadSceneData();
    // Same call ensureData() makes in app.js: one seeded prng per robot id.
    const built = def.buildData(mulberry32(seedFor(id)));
    out[id] = {
      name: def.name,
      device: def.device,
      tagline: def.tagline,
      duration: def.duration,
      evidenceIds: def.findings.map((f) => f.id),
      suggested: def.suggested || [],
      facts: buildFacts(def, built, siblings),
    };
    process.stdout.write(`${id}: ${out[id].facts.length} chars (~${Math.round(out[id].facts.length / 3.6)} tokens)\n`);
  }

  const banner = `// GENERATED by worker/build-facts.mjs - do not edit by hand.
// Re-run \`node worker/build-facts.mjs\` after changing any robot's data.js or script.js.
`;
  await writeFile(
    path.join(ROOT, 'worker', 'facts.generated.js'),
    `${banner}\nexport const FACTS = ${JSON.stringify(out, null, 2)};\n`,
  );
  process.stdout.write('wrote worker/facts.generated.js\n');
}

// Run the CLI only when this file IS the entry point. An `import` (the runner's runtime snapshot)
// gets the builders above and touches neither demo/js nor facts.generated.js.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
