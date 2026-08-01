// donna-deident.test.mjs - fail-closed de-identification gate for Donna's public replay.
//
// Default invocation requires the private extraction manifest. --dev-partial runs generic identifier
// patterns only and certifies nothing about the source-specific needles.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTS } from '../../../../worker/facts.generated.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DONNA_DIR = path.join(ROOT, 'demo', 'js', 'robots', 'donna');
const GEN_FIXTURE_DIR = path.join(ROOT, 'demo', 'js', 'robots', 'gen-fixture');
const argv = process.argv.slice(2);
const DEV_PARTIAL = argv.includes('--dev-partial');
const argManifest = argv.includes('--manifest') ? argv[argv.indexOf('--manifest') + 1] : null;
const MANIFEST =
  argManifest ||
  process.env.DONNA_DEIDENT_MANIFEST ||
  path.join(
    process.env.HOME || '',
    'Documents/clients/alloy/reels/_scratch/donna-mcap/out/deident-manifest.json',
  );

let failures = 0;
let checks = 0;
const fail = (message) => {
  failures++;
  console.error(`  LEAK  ${message}`);
};
const check = (condition, message) => {
  checks++;
  if (!condition) fail(message);
};

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...filesUnder(abs));
    else out.push(abs);
  }
  return out;
}

// Generated modules carry one large base64 literal. Generic text patterns inside encoded bytes are
// noise, while manifest needles are still checked against the unscripted source around the blob.
const blankBlob = (text) =>
  text.replace(/(BLOB_B64\s*=\s*")([^"]*)(")/g, (_match, a, body, c) => a + ' '.repeat(body.length) + c);

const donnaFixtureFiles = readdirSync(GEN_FIXTURE_DIR)
  .filter((name) => name.startsWith('donna-'))
  .flatMap((name) => {
    const abs = path.join(GEN_FIXTURE_DIR, name);
    return statSync(abs).isDirectory() ? filesUnder(abs) : [abs];
  });
const units = [...filesUnder(DONNA_DIR), ...donnaFixtureFiles].map((abs) => ({
  label: path.relative(ROOT, abs),
  text: readFileSync(abs, 'utf8'),
}));
if (FACTS.donna) units.push({ label: 'worker/facts.generated.js#donna', text: JSON.stringify(FACTS.donna) });
else fail('worker/facts.generated.js has no Donna pack; run npm run facts before this gate');

// Loopback identifies no person, device or source network, so these three literals are the only
// network identifiers allowed on Donna-named public surfaces.
const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1', 'localhost']);
const isAllowedLoopback = (ruleName, value) => {
  const folded = value.toLocaleLowerCase('en-US');
  if (LOOPBACK_LITERALS.has(folded)) return true;
  if (ruleName === 'host:port identifier') return LOOPBACK_LITERALS.has(folded.replace(/:\d+$/, ''));
  return false;
};

const generic = [
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

console.log('Donna de-identification gate');
console.log(`surface: ${units.length} Donna files/facts units`);
for (const unit of units) {
  const text = blankBlob(unit.text);
  for (const rule of generic) {
    rule.re.lastIndex = 0;
    const matches = [...text.matchAll(rule.re)];
    if (!matches.length) {
      check(true, `${unit.label}: no ${rule.name}`);
      continue;
    }
    for (const match of matches) {
      check(
        isAllowedLoopback(rule.name, match[0]),
        `${unit.label}: ${rule.name} ${JSON.stringify(match[0])} at character ${match.index}`,
      );
    }
  }
}

if (DEV_PARTIAL) {
  console.log('DEV PARTIAL: private manifest not required; source-specific needles were NOT checked.');
} else if (!existsSync(MANIFEST)) {
  fail('private Donna de-identification manifest is missing; default gate fails closed');
} else {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch {
    fail('private Donna de-identification manifest is not valid JSON');
  }
  if (manifest) {
    check(typeof manifest.hostname === 'string', 'manifest hostname is a string');
    check(Array.isArray(manifest.interface_names), 'manifest interface_names is an array');
    check(Array.isArray(manifest.serials), 'manifest serials is an array');
    const groups = [
      ['hostname', [manifest.hostname]],
      ['interface_names', manifest.interface_names || []],
      ['serials', manifest.serials || []],
    ];
    for (const [group, values] of groups) {
      for (let i = 0; i < values.length; i++) {
        const needle = values[i];
        if (typeof needle !== 'string' || !needle) {
          fail(`manifest ${group}[${i}] is not a non-empty string`);
          continue;
        }
        const folded = needle.toLocaleLowerCase('en-US');
        for (const unit of units) {
          // Source-specific identifiers are checked against the full text, including generated
          // modules. A real needle in the encoded payload must fail rather than being dismissed.
          const hit = unit.text.toLocaleLowerCase('en-US').includes(folded);
          check(!hit, `${unit.label}: contains private manifest needle ${group}[${i}]`);
        }
      }
    }
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
