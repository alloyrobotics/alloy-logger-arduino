// build-facts.mjs - generates the grounding facts pack the /demo/api/chat endpoint feeds Claude.
//
// The demo's telemetry is synthesized deterministically in the browser from each robot's
// data.js. This script runs those same generators in Node with the same seed app.js uses, then
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

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROBOTS_DIR = path.join(ROOT, 'demo', 'js', 'robots');
const ROBOT_IDS = ['sbr', 'arm6', 'drone', 'rescue'];

/** How many points a whole-mission series is downsampled to. */
const SERIES_POINTS = 80;
/** How many points the dense excerpt around a finding window gets. */
const WINDOW_POINTS = 30;

// ---------------------------------------------------------------------------- loading

/**
 * script.js is the RobotDefinition (name, tagline, suggested questions, verified answers) but it
 * also imports scene.js, which imports three.js and does not load outside a browser. Rather than
 * duplicate the prose into this script - where it would drift - rewrite that one import in a
 * throwaway sibling module and import that. The temp file lives next to the original so its
 * relative './data.js' import still resolves.
 */
async function loadRobotDefinition(id) {
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
function fmt(v) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

const fmtT = (t) => `${t.toFixed(2)}s`;

/** Evenly spaced indices across [lo, hi], inclusive of both ends. */
function pickIndices(lo, hi, count) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const n = Math.min(count, span + 1);
  const out = [];
  for (let k = 0; k < n; k++) out.push(lo + Math.round((span * k) / (n - 1)));
  return [...new Set(out)];
}

/** First index whose time is >= s. */
function indexAt(times, s) {
  for (let i = 0; i < times.length; i++) if (times[i] >= s) return i;
  return times.length - 1;
}

// ---------------------------------------------------------------------------- facts sections

function statsFor(series, times) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let minI = 0;
  let maxI = 0;
  let n = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
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
  return {
    min,
    max,
    mean: sum / n,
    minT: times[minI],
    maxT: times[maxI],
    first: series[0],
    last: series[series.length - 1],
  };
}

function channelSection(def, data) {
  const lines = [];
  for (const ch of def.channels) {
    const block = data[ch.path];
    if (!block) continue;
    const times = block.t;
    lines.push(`### ${ch.path} — ${times.length} samples, ${fmtT(times[0])} to ${fmtT(times[times.length - 1])}`);
    lines.push('');
    lines.push('| field | unit | first | last | min (at) | max (at) | mean |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const f of ch.fields) {
      const s = statsFor(block[f.key] || [], times);
      if (!s) continue;
      lines.push(
        `| ${f.key} | ${f.unit || '-'} | ${fmt(s.first)} | ${fmt(s.last)} | ` +
          `${fmt(s.min)} (${fmtT(s.minT)}) | ${fmt(s.max)} (${fmtT(s.maxT)}) | ${fmt(s.mean)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** A whole-mission table so the model can answer "what was X doing at t". */
function seriesSection(def, data) {
  const lines = [];
  for (const ch of def.channels) {
    const block = data[ch.path];
    if (!block) continue;
    const times = block.t;
    const keys = ch.fields.map((f) => f.key).filter((k) => Array.isArray(block[k]) || ArrayBuffer.isView(block[k]));
    if (!keys.length) continue;
    const idx = pickIndices(0, times.length - 1, SERIES_POINTS);
    lines.push(`### ${ch.path} sampled every ~${fmt((times[times.length - 1] - times[0]) / (idx.length - 1))} s`);
    lines.push('');
    lines.push(`| t (s) | ${keys.join(' | ')} |`);
    lines.push(`| --- | ${keys.map(() => '---').join(' | ')} |`);
    for (const i of idx) {
      lines.push(`| ${times[i].toFixed(1)} | ${keys.map((k) => fmt(block[k][i])).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Dense excerpt across each finding's window, on the fields that finding focuses. */
function findingsSection(def, data) {
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
    const block = focus && data[focus.channel];
    if (block) {
      const times = block.t;
      const lo = indexAt(times, w[0]);
      const hi = indexAt(times, w[1]);
      const keys = (focus.fields || []).filter((k) => block[k]);
      if (keys.length) {
        // Uniform sampling can step right over the one sample the finding is about (the sbr I2C
        // spike is a single row). Union in the cited instant and each focused field's extremes
        // inside the window so the anomalous values are always in the table.
        const idx = new Set(pickIndices(lo, hi, WINDOW_POINTS));
        if (f.t != null) idx.add(indexAt(times, f.t));
        for (const k of keys) {
          let minI = lo;
          let maxI = lo;
          for (let i = lo; i <= hi; i++) {
            const v = block[k][i];
            if (!Number.isFinite(v)) continue;
            if (v < block[k][minI] || !Number.isFinite(block[k][minI])) minI = i;
            if (v > block[k][maxI] || !Number.isFinite(block[k][maxI])) maxI = i;
          }
          idx.add(minI);
          idx.add(maxI);
        }
        lines.push(`${focus.channel} across the window:`);
        lines.push('');
        lines.push(`| t (s) | ${keys.join(' | ')} |`);
        lines.push(`| --- | ${keys.map(() => '---').join(' | ')} |`);
        for (const i of [...idx].sort((a, b) => a - b)) {
          lines.push(`| ${times[i].toFixed(2)} | ${keys.map((k) => fmt(block[k][i])).join(' | ')} |`);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

/** The hand-verified answers, verbatim. These carry the analyst voice and the causal story. */
function analysesSection(def) {
  const lines = [];
  for (const entry of def.script || []) {
    lines.push(`### topic: ${entry.id}`);
    lines.push(`asked when the question is about: ${(entry.matchers || []).join(', ')}`);
    lines.push('');
    lines.push(entry.answer.trim());
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The ONLY product facts the analyst may state. Hand-written from README.md + the landing page;
 * everything else about Alloy gets deflected to usealloy.ai, because the model's ordinary
 * knowledge of "Alloy" is a different company.
 */
const ABOUT_PRODUCT = `## About the product

The only product facts you may state; anything about Alloy this does not cover, point at usealloy.ai.

- AlloyLogger is a free, open-source (MIT) Arduino library for ESP32 that streams sensor and telemetry data straight to Alloy in about ten lines: you log name -> value pairs at the call site, the library RAM-buffers them and uploads in the background. No SD card, no flash wear, never blocks the control loop.
- Every power-on lands in Alloy as one replayable MCAP mission: replay it, scrub it, query it with SQL, ask about it the way this visitor is asking you.
- Alloy is the robotics data platform by Alloy Robotics: usealloy.ai. The library and docs: github.com/alloyrobotics/alloy-logger-arduino, or the Get started section on alloylogger.com.
- Pricing and accounts are not covered here: usealloy.ai.
- This page's four missions are demo logs generated for the browser; no account or hardware is needed to explore them.
`;

/** One line per sibling so "what about the drone?" gets a useful pointer, not a shrug. */
function otherMissionsSection(def, all) {
  const lines = ['## Other missions on this page', ''];
  lines.push('The visitor can switch demos with the robot picker (top of the page). You only see this mission.');
  for (const o of all) {
    if (o.id === def.id) continue;
    lines.push(`- ${o.name} (\`${o.id}\`): ${o.tagline}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildFacts(def, data, all) {
  const evidenceIds = def.findings.map((f) => f.id);
  return `# Mission: ${def.name}

- robot id: \`${def.id}\`
- hardware: ${def.device}
- one-line summary: ${def.tagline}
- log duration: ${fmt(def.duration)} s at ${def.rate} Hz
- valid evidence ids (the ONLY ids you may cite): ${evidenceIds.map((id) => `\`${id}\``).join(', ')}

## Findings

${findingsSection(def, data)}
## Channel statistics

${channelSection(def, data)}
## Telemetry, sampled across the whole mission

${seriesSection(def, data)}
## Verified analyses

These were written and fact-checked against this exact log. When a visitor asks something one of
them already answers, reuse its numbers and its conclusion. Rephrase freely; do not contradict.

${analysesSection(def)}
${otherMissionsSection(def, all)}
${ABOUT_PRODUCT}`;
}

// ---------------------------------------------------------------------------- main

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
