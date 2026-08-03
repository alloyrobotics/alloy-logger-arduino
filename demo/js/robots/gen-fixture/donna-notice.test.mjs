// donna-notice.test.mjs - redistributed Wolfgang-OP CAD retains its upstream MIT notice.
//
//   node demo/js/robots/gen-fixture/donna-notice.test.mjs

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const notice = await readFile(path.join(ROOT, 'THIRD_PARTY_NOTICES'), 'utf8');
const expectedLicenseSha256 = 'f8d75738b56ed9979ed9a0f233fe17466b7b8b0740d17ff44425d878b66e6757';

let failures = 0;
let checks = 0;
const ok = (condition, message) => {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${message}`);
  }
};

ok(notice.startsWith('Wolfgang-OP robot CAD meshes\n'), 'notice names the redistributed CAD');
ok(notice.includes('https://github.com/bit-bots/wolfgang_robot'), 'notice identifies the upstream repository');
ok(notice.includes('Revision: b067cae'), 'notice pins the consumed upstream revision');
ok(notice.includes('License: MIT'), 'notice identifies the MIT license');

const split = notice.indexOf('\n\n');
const license = split >= 0 ? notice.slice(split + 2) : '';
const upstreamText = license.endsWith('\n') ? license.slice(0, -1) : license;
const actualLicenseSha256 = createHash('sha256').update(upstreamText, 'utf8').digest('hex');
ok(actualLicenseSha256 === expectedLicenseSha256, 'upstream MIT text is present verbatim');
ok(/Copyright \(c\) Hamburg Bit-Bots/.test(license), 'upstream copyright is preserved');
ok(/THE SOFTWARE IS PROVIDED "AS IS"/.test(license), 'upstream warranty disclaimer is preserved');

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
