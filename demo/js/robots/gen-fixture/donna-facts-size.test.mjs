// donna-facts-size.test.mjs - frozen analyst-pack ceiling for Donna.

import { FACTS } from '../../../../worker/facts.generated.js';

const CEILING_CHARS = 31500;
const pack = FACTS.donna;

if (!pack || typeof pack.facts !== 'string') {
  console.error('FAIL  worker/facts.generated.js has no Donna facts pack. Run npm run facts.');
  process.exit(1);
}

const length = pack.facts.length;
console.log(`Donna facts pack: ${length} chars`);
console.log(`ceiling: ${CEILING_CHARS} chars`);
console.log(`margin: ${CEILING_CHARS - length} chars`);

if (length > CEILING_CHARS) {
  console.error(
    `FAIL  Donna facts pack exceeds the ${CEILING_CHARS}-char ceiling by ${length - CEILING_CHARS}. ` +
      'Reduce def.factsSeriesPoints toward the 40-point floor, then analyses count. Do not cut ' +
      'provenance, attribution, disclosure or mandatory event rows.',
  );
  process.exit(1);
}

console.log('1/1 checks passed');
