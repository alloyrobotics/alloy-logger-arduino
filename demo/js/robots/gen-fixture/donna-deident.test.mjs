// donna-deident.test.mjs - fail-closed three-robot de-identification gate.
//
// The private manifest is required by default. It must contain exactly Donna, Jack and Rory records.
// Every source-specific needle is derived from those records, then checked against public text and
// against the decoded bytes of both generated module blobs.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FACTS } from '../../../../worker/facts.generated.js';
import * as fullModule from '../donna/donna-data.js';
import * as previewModule from '../donna/preview-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DONNA_DIR = path.join(ROOT, 'demo', 'js', 'robots', 'donna');
const GEN_FIXTURE_DIR = path.join(ROOT, 'demo', 'js', 'robots', 'gen-fixture');
const DEFAULT_MANIFEST = path.join(
  process.env.HOME || '',
  'Documents/clients/alloy/reels/_scratch/donna-mcap/out/go25-0316/deident-manifest.json',
);
const argv = process.argv.slice(2);
const argManifest = argv.includes('--manifest') ? argv[argv.indexOf('--manifest') + 1] : null;
const MANIFEST = argManifest || process.env.DONNA_DEIDENT_MANIFEST || DEFAULT_MANIFEST;
const PROBE_MANIFEST_ONLY = argv.includes('--probe-manifest-only');

function validateManifest(manifestPath) {
  const errors = [];
  if (!manifestPath || !existsSync(manifestPath)) {
    errors.push('private Donna de-identification manifest is missing');
    return { errors, records: [], needles: [] };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    errors.push('private Donna de-identification manifest is not valid JSON');
    return { errors, records: [], needles: [] };
  }
  if (!manifest || manifest.format !== 'donna-team-private-deident/1' || !Array.isArray(manifest.records)) {
    errors.push('private Donna de-identification manifest has the wrong top-level schema');
    return { errors, records: [], needles: [] };
  }
  if (manifest.records.length !== 3) errors.push('private manifest must contain exactly three records');
  const expectedRobots = ['donna', 'jack', 'rory'];
  const records = manifest.records;
  const robotNames = records.map((record) => record && record.robot).sort();
  if (JSON.stringify(robotNames) !== JSON.stringify(expectedRobots)) {
    errors.push('private manifest must contain one unique record for Donna, Jack and Rory');
  }
  const needles = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(`record ${i} is not an object`);
      continue;
    }
    const keys = Object.keys(record).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['hostname', 'interface_names', 'robot', 'serials'])) {
      errors.push(`record ${i} has the wrong fields`);
    }
    if (typeof record.robot !== 'string' || !expectedRobots.includes(record.robot)) {
      errors.push(`record ${i} has an invalid robot`);
    }
    if (typeof record.hostname !== 'string' || !record.hostname) {
      errors.push(`record ${i} hostname is not a non-empty string`);
    } else {
      needles.push({ group: `${record.robot}.hostname`, value: record.hostname });
    }
    for (const field of ['interface_names', 'serials']) {
      if (!Array.isArray(record[field])) {
        errors.push(`record ${i} ${field} is not an array`);
        continue;
      }
      for (let j = 0; j < record[field].length; j++) {
        const value = record[field][j];
        if (typeof value !== 'string' || !value) errors.push(`record ${i} ${field}[${j}] is not a non-empty string`);
        else needles.push({ group: `${record.robot}.${field}[${j}]`, value });
      }
    }
  }
  const folded = needles.map((needle) => needle.value.toLocaleLowerCase('en-US'));
  if (new Set(folded).size !== folded.length) errors.push('private manifest needles must be unique');
  return { errors, records, needles };
}

if (PROBE_MANIFEST_ONLY) {
  const result = validateManifest(MANIFEST);
  if (result.errors.length) {
    console.error(result.errors.join('\n'));
    process.exit(1);
  }
  console.log(`valid private manifest: ${result.records.length} records, ${result.needles.length} needles`);
  process.exit(0);
}

let failures = 0;
let checks = 0;
function check(condition, message) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  LEAK  ${message}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

function filesUnder(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) out.push(...filesUnder(absolute));
    else out.push(absolute);
  }
  return out;
}

function bloblessSource(text) {
  return text.replace(/(BLOB_B64\s*=\s*")([^"]*)(")/g, (_match, open, body, close) => {
    return open + ' '.repeat(body.length) + close;
  });
}

const fixtureFiles = readdirSync(GEN_FIXTURE_DIR)
  .filter((name) => name.startsWith('donna-'))
  .flatMap((name) => {
    const absolute = path.join(GEN_FIXTURE_DIR, name);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  });
const textUnits = [...filesUnder(DONNA_DIR), ...fixtureFiles].map((absolute) => ({
  label: path.relative(ROOT, absolute),
  text: readFileSync(absolute, 'utf8'),
}));
if (FACTS.donna) textUnits.push({ label: 'worker/facts.generated.js#donna', text: JSON.stringify(FACTS.donna) });
else {
  failures++;
  console.error('  LEAK  worker/facts.generated.js has no Donna pack; run npm run facts before this gate');
}
const blobUnits = [
  { label: 'demo/js/robots/donna/donna-data.js#decoded-BLOB_B64', bytes: Buffer.from(fullModule.BLOB_B64, 'base64') },
  { label: 'demo/js/robots/donna/preview-data.js#decoded-BLOB_B64', bytes: Buffer.from(previewModule.BLOB_B64, 'base64') },
];

section('manifest cardinality and fail-closed probes');
const manifest = validateManifest(MANIFEST);
for (const error of manifest.errors) {
  failures++;
  console.error(`  LEAK  ${error}`);
}
check(manifest.records.length === 3, 'manifest has exactly three records');
check(manifest.needles.length >= 3, 'needles are derived from all three records');

const temp = mkdtempSync(path.join(os.tmpdir(), 'donna-deident-'));
try {
  const missing = path.join(temp, 'missing.json');
  const invalid = path.join(temp, 'invalid.json');
  const short = path.join(temp, 'short.json');
  writeFileSync(invalid, '{not json', 'utf8');
  writeFileSync(
    short,
    JSON.stringify({ format: 'donna-team-private-deident/1', records: manifest.records.slice(0, 2) }),
    'utf8',
  );
  for (const [label, manifestPath] of [['missing', missing], ['invalid', invalid], ['short', short]]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe-manifest-only', '--manifest', manifestPath], {
      encoding: 'utf8',
    });
    check(child.status !== 0, `${label} manifest exits non-zero`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

section('generic IP, MAC and host:port patterns');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const isAllowedLoopback = (ruleName, value) => {
  const folded = value.toLocaleLowerCase('en-US');
  if (LOOPBACK.has(folded)) return true;
  return ruleName === 'host:port identifier' && LOOPBACK.has(folded.replace(/:\d+$/, ''));
};
const genericRules = [
  {
    name: 'IPv4 address',
    re: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g,
  },
  {
    name: 'IPv6 address',
    re: /(?<![0-9A-Fa-f:])(?:::1|(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4})(?![0-9A-Fa-f:])/g,
  },
  {
    name: 'MAC address',
    re: /(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])/g,
  },
  {
    name: 'host:port identifier',
    re: /\b(?:localhost|[A-Za-z][A-Za-z0-9_-]{2,}|[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}):(?:[1-9]\d{1,4})\b/g,
  },
];
const genericUnits = [
  ...textUnits.map((unit) => ({ label: unit.label, text: bloblessSource(unit.text) })),
  ...blobUnits.map((unit) => ({ label: unit.label, text: unit.bytes.toString('latin1') })),
];
for (const unit of genericUnits) {
  for (const rule of genericRules) {
    rule.re.lastIndex = 0;
    const matches = [...unit.text.matchAll(rule.re)];
    if (!matches.length) {
      check(true, `${unit.label}: no ${rule.name}`);
      continue;
    }
    for (const match of matches) {
      check(isAllowedLoopback(rule.name, match[0]), `${unit.label}: ${rule.name} at character ${match.index}`);
    }
  }
}

section('source-specific manifest needles');
function sourceNeedleHits(units, needles) {
  const hits = [];
  for (const unit of units) {
    const folded = unit.text.toLocaleLowerCase('en-US');
    for (const needle of needles) {
      if (folded.includes(needle.value.toLocaleLowerCase('en-US'))) hits.push({ label: unit.label, group: needle.group });
    }
  }
  return hits;
}
function blobNeedleHits(units, needles) {
  const hits = [];
  for (const unit of units) {
    const folded = unit.bytes.toString('latin1').toLocaleLowerCase('en-US');
    for (const needle of needles) {
      if (folded.includes(needle.value.toLocaleLowerCase('en-US'))) hits.push({ label: unit.label, group: needle.group });
    }
  }
  return hits;
}
const needleTextUnits = textUnits.map((unit) => ({ label: unit.label, text: bloblessSource(unit.text) }));
for (const hit of sourceNeedleHits(needleTextUnits, manifest.needles)) {
  check(false, `${hit.label}: contains private manifest needle ${hit.group}`);
}
for (const hit of blobNeedleHits(blobUnits, manifest.needles)) {
  check(false, `${hit.label}: decoded bytes contain private manifest needle ${hit.group}`);
}
check(sourceNeedleHits(needleTextUnits, manifest.needles).length === 0, 'public text outside encoded blobs contains no manifest needles');
check(blobNeedleHits(blobUnits, manifest.needles).length === 0, 'decoded module blobs contain no manifest needles');

section('encoded-needle mutation proves the gate has teeth');
if (manifest.needles.length) {
  const planted = manifest.needles[0];
  const mutation = [{
    label: 'mutation#decoded-BLOB_B64',
    bytes: Buffer.concat([blobUnits[0].bytes, Buffer.from(`\0${planted.value}\0`, 'utf8')]),
  }];
  const hits = blobNeedleHits(mutation, manifest.needles);
  check(hits.some((hit) => hit.group === planted.group), 'a needle planted only in decoded blob bytes is detected');
  const encoded = Buffer.from(planted.value, 'utf8').toString('base64');
  check(!encoded.toLocaleLowerCase('en-US').includes(planted.value.toLocaleLowerCase('en-US')), 'mutation is encoded rather than literal source text');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
