// battle-eager-size.test.mjs - the battle mission's EAGER payload budget, enforced.
//
//   node demo/js/robots/gen-fixture/battle-eager-size.test.mjs
//
// The battle round is the page's second lazy mission: `script.js` and everything it imports
// STATICALLY ships to every visitor who so much as opens the picker, while `battle-data.js` (the
// generated 180 s round) is fetched with a dynamic import on the demo route only. Nothing enforced
// that boundary, so it could rot back into an eager payload one honest-looking import at a time.
// This is that enforcement, and it is the same measurement the SSL mission already lives under.
//
// WHAT IS MEASURED. Start at `demo/js/robots/battle/script.js`, follow STATIC imports only, and
// keep the ones that resolve inside `demo/js/robots/battle/`. A dynamic `import()` is not a static
// import, so the lazy round module drops out BY CONSTRUCTION rather than by an exclusion list -
// which is the property worth testing: convert that dynamic import to a static one and this test
// goes from a kilobyte of margin to hundreds of kilobytes over, and says so.
//
// Modules OUTSIDE that directory are reported but not charged: they are the shared page runtime,
// loaded for every robot whether or not this mission exists, so charging them to the battle budget
// would measure the page rather than the mission. (Today there are none: the battle graph is
// self-contained.)
//
// THE NUMBER. The gate is the gzip of the graph as one payload, at level 9 pinned so the result is
// deterministic across machines and Node versions, over the files in sorted order. The SUM of
// per-file gzip is printed beside it because that is what separate module requests actually cost
// (each file pays its own header and dictionary warm-up); the CDN serves these with Brotli, which
// lands under both.
//
// Exits 0 when the eager graph is within budget.

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BATTLE_DIR = path.join(HERE, '..', 'battle');
const ENTRY = path.join(BATTLE_DIR, 'script.js');

/**
 * 46,900 B. Measured at 45,855 B on the completed implementation, so this is a real ceiling with
 * about a kilobyte of authoring margin, not a number reverse-engineered from the graph.
 *
 * WHY THE GRAPH IS THE SIZE IT IS, stated so a future reader does not "fix" the wrong thing:
 *
 *   - `claims.mjs` rides the eager graph BY DESIGN. `data.js` renders every finding narrative FROM
 *     the claim ledger, which is exactly what makes the prose equal the ledger structurally rather
 *     than by review. `findings` is a static export the picker and the brief read before any round
 *     payload exists, so the ledger cannot move behind the lazy boundary without putting the
 *     numbers back into hand-typed strings. The ~4.4 KB it costs buys the property the whole
 *     mission is built on.
 *   - The scene is at parity with the SSL exemplar: an arena, four robots, tracers and the HUD
 *     producer cost what the SSL field, twelve robots and its HUD producer cost.
 *   - The SSL closure ships under its own 58,368 B ceiling, so battle stays the SMALLER of the two
 *     lazy missions and this ceiling does not become the page's new high-water mark.
 *
 * NON-COPY growth moves behind the lazy round boundary. Raising this number is not the remedy.
 */
const CEILING_BYTES = 46900;

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
      ok(false, `${path.relative(BATTLE_DIR, abs)} imports "${spec}", which does not exist`);
      continue;
    }
    if (path.relative(BATTLE_DIR, target).startsWith('..')) {
      if (!shared.includes(target)) shared.push(target);
      continue;
    }
    walk(target);
  }
}

walk(ENTRY);

let perFileSum = 0;
const bufs = [];
console.log('eager battle module graph (static imports from script.js, battle/ only):\n');
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
} else {
  console.log('the battle graph reaches nothing outside its own directory.\n');
}

ok(
  !eager.some((abs) => path.basename(abs) === 'battle-data.js'),
  'the generated round module is NOT in the eager graph - it must stay behind a dynamic import()',
);
ok(
  eager.some((abs) => path.basename(abs) === 'preview-data.js'),
  'the preview slice IS in the eager graph, which is what lets the picker and the brief pose the arena',
);
ok(
  eager.some((abs) => path.basename(abs) === 'claims.mjs'),
  'the claim ledger IS in the eager graph, because data.js renders the finding narratives from it',
);
ok(
  total <= CEILING_BYTES,
  `the eager battle graph is ${total} B gzipped as one payload, over the ${CEILING_BYTES} B ceiling by ` +
    `${total - CEILING_BYTES} B. Move the growth behind the lazy round boundary ` +
    '(demo/DESIGN.md, "battle (robot agent 6)") rather than raising this number.',
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
