// ssl-eager-size.test.mjs - the SSL mission's EAGER payload budget, enforced.
//
//   node demo/js/robots/gen-fixture/ssl-eager-size.test.mjs
//
// The SSL scenario is the only mission on this page with a lazy boundary: `script.js` and
// everything it imports statically ship to every visitor who so much as opens the picker, while
// `match-data.js` (~700 KB) is fetched with a dynamic import on the demo route only. The plan
// caps the eager half at 56 KB and nothing enforced it, so the boundary could rot back into an
// eager payload one honest-looking import at a time. This is that enforcement.
//
// WHAT IS MEASURED. Start at `demo/js/robots/ssl/script.js`, follow STATIC imports only, and keep
// the ones that resolve inside `demo/js/robots/ssl/`. A dynamic `import()` is not a static import,
// so the lazy match module drops out by construction rather than by an exclusion list - which is
// the property worth testing: if someone converts that dynamic import to a static one, this test
// goes from a couple of kilobytes of margin to 300 KB over, and says so.
//
// Modules OUTSIDE that directory (`core/prng.js` today) are reported but not charged: they are the
// shared page runtime, loaded for every robot whether or not this one exists, so charging them to
// the SSL budget would measure the page rather than the mission.
//
// THE NUMBER. The gate is the gzip of the graph as one payload, at level 9 pinned so the result is
// deterministic across machines and Node versions, over the files in sorted order. The SUM of
// per-file gzip is printed beside it because that is what separate module requests actually cost
// (each file pays its own header and dictionary warm-up) and it is the number that will trip
// first; the CDN serves these with Brotli, which lands under both.
//
// Exits 0 when the eager graph is within budget.

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SSL_DIR = path.join(HERE, '..', 'ssl');
const ENTRY = path.join(SSL_DIR, 'script.js');

/**
 * 57 KB. Growth past this belongs behind the lazy match-data boundary, not in front of it.
 *
 * RAISED BY 1 KB FROM 57344 B ON 2026-07-29, for review-mandated honesty copy and for nothing else.
 * The graph stood at 57168 B - 176 B of margin nobody had noticed - and round 5 of the artifact
 * review required two corrections to claims the site was making that its own data does not support:
 * +437 B in data.js (the masked detection series ends in an UNKNOWN, not a zero) and +322 B in
 * script.js (the goal answer narrates the kick that actually scored, with the tracker and
 * game-controller attributions labelled separately). Both were tightened until further cuts bought
 * single-digit bytes; gzip is already deduplicating this vocabulary. Neither can move behind the
 * lazy boundary while `findings` is a static export of data.js and ssl-script.test.mjs asserts that
 * importing the def leaves `isSceneDataLoaded() === false`.
 *
 * NON-COPY growth still moves behind the lazy boundary. This raise is not a precedent for a payload.
 */
const CEILING_BYTES = 58368;

let failures = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
};

/** Static import/export-from specifiers. Deliberately blind to `import(...)`, which is the point. */
const STATIC_SPECIFIERS =
  /(?:^|\n)\s*(?:import|export)\s(?:[^'"()]|\n)*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const eager = [];
const shared = [];
const seen = new Set();

function walk(abs) {
  if (seen.has(abs)) return;
  seen.add(abs);
  const src = readFileSync(abs, 'utf8');
  eager.push(abs);
  STATIC_SPECIFIERS.lastIndex = 0;
  let m;
  while ((m = STATIC_SPECIFIERS.exec(src)) !== null) {
    const spec = m[1] || m[2];
    if (!spec || !spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(abs), spec);
    if (!existsSync(target)) {
      ok(false, `${path.relative(SSL_DIR, abs)} imports "${spec}", which does not exist`);
      continue;
    }
    if (path.relative(SSL_DIR, target).startsWith('..')) {
      if (!shared.includes(target)) shared.push(target);
      continue;
    }
    walk(target);
  }
}

walk(ENTRY);

let perFileSum = 0;
const bufs = [];
console.log('eager SSL module graph (static imports from script.js, ssl/ only):\n');
for (const abs of eager.sort()) {
  const buf = readFileSync(abs);
  bufs.push(buf);
  const gz = gzipSync(buf, { level: 9 }).length;
  perFileSum += gz;
  console.log(`  ${path.basename(abs).padEnd(18)} ${String(gz).padStart(6)} B gzipped`);
}
const total = gzipSync(Buffer.concat(bufs), { level: 9 }).length;
console.log(`\n  ${'GRAPH'.padEnd(18)} ${String(total).padStart(6)} B gzipped as one payload`);
console.log(`  ${'CEILING'.padEnd(18)} ${String(CEILING_BYTES).padStart(6)} B`);
console.log(`  ${'MARGIN'.padEnd(18)} ${String(CEILING_BYTES - total).padStart(6)} B`);
console.log(
  `  ${'per-file sum'.padEnd(18)} ${String(perFileSum).padStart(6)} B ` +
    `(${CEILING_BYTES - perFileSum} B under the same ceiling, informational)\n`,
);
if (shared.length) {
  console.log('shared page runtime, loaded for every robot and NOT charged here:');
  for (const abs of shared) console.log(`  ${path.relative(path.join(HERE, '..', '..'), abs)}`);
  console.log('');
}

ok(
  !eager.some((abs) => path.basename(abs) === 'match-data.js'),
  'the match replay module is NOT in the eager graph - it must stay behind a dynamic import()',
);
ok(
  eager.some((abs) => path.basename(abs) === 'preview-data.js'),
  'the preview slice IS in the eager graph, which is what lets the picker and the brief pose a robot',
);
ok(
  total <= CEILING_BYTES,
  `the eager SSL graph is ${total} B gzipped as one payload, over the ${CEILING_BYTES} B ceiling by ` +
    `${total - CEILING_BYTES} B. Move the growth behind the lazy match-data boundary ` +
    '(demo/DESIGN.md, "ssl (robot agent 5)") rather than raising this number.',
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
