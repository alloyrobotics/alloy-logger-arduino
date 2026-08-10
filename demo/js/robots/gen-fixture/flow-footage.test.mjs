// flow-footage.test.mjs - the mission step's REAL FOOTAGE layer, in plain Node.
//
//   node demo/js/robots/gen-fixture/flow-footage.test.mjs
//
// No browser and no Playwright. Round 11 swapped the sim replay on the middle step of the three-step
// flow for real footage of the same CLASS of robot doing the same kind of work, because that step is
// the one that answers "how does the game / the survey / the transfer work" and a synthesized replay
// is the weakest answer to it. Three separate things can rot here, and all three are checkable
// without a page:
//
//   1  THE DECLARATIONS. All four public missions declare `experience.success.footage`, the media
//      they name is on disk, and it is small enough to be worth autoplaying on a phone. The two lazy
//      missions are loaded through their own side modules, exactly as `experience.test.mjs` does, so
//      a declaration that moved into an eager file (where ssl has double-digit bytes of gzip
//      headroom) is not silently accepted here.
//
//   2  THE HONESTY COPY, which is the part a reviewer cannot see is missing. None of this footage is
//      the logged mission - it cannot be, the logs are a different day and in two cases a different
//      match - so every note has to say so ON the video, and none of them may name a team, an event,
//      a city or a year-event pair anywhere: `ssl-leak-check.mjs` scans every tracked file including
//      the filenames, and this is the cheap gate that fails first and says why. The notes are held to
//      an ALLOWLIST rather than a pattern, because "generic enough" is a judgement and an allowlist
//      is a decision: changing one is a review, not an edit.
//
//   3  THE FAIL-OPEN WIRING. Footage is OPTIONAL and its absence must be the pre-round-11 behaviour
//      exactly, which is two properties of `core/flow.js` source: every read of the key is guarded
//      (so battle, sbr, rescue, the stub and every generated g-* def are untouched), and the video's
//      own `error` event retires the footage and re-renders the step as the sim. A visitor whose
//      media request is blocked gets the experience that shipped before this round, not a black
//      panel, and that is a promise about a code path no fast test can execute - so it is asserted
//      on the source, structurally, one assertion per link in the chain.
//
// Exits 0 when the footage contract holds.

import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROBOTS, ROBOTS_BY_ID } from '../index.js';
import { applyRoleOpeners as applySslSideModule } from '../ssl/role-openers.js';
import { applyExperience as applyDonnaExperience } from '../donna/experience.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(HERE, '..', '..', '..');
const FLOW_JS = path.join(DEMO, 'js', 'core', 'flow.js');
const INDEX_HTML = path.join(DEMO, 'index.html');

const MISSIONS = ['arm6', 'drone', 'ssl', 'donna'];

/**
 * THE ALLOWLIST. Every note that may appear over real footage on this site, verbatim.
 *
 * Two halves each, and both are required. The first says what the footage IS, in terms of a CLASS of
 * machine and a kind of work. The second says what it is NOT, because the step's own heading is
 * about a mission the visitor is one click away from interrogating, and a real machine playing under
 * that heading would otherwise be read as that mission.
 */
const NOTES = Object.freeze({
  arm6: 'A 6-axis arm sorting parts. Not the logged run.',
  drone: 'A survey-class quadcopter in flight. Not the logged flight.',
  ssl: 'Real Small Size League footage. Not the logged match.',
  donna: 'Real humanoid-league match footage. Not the logged match.',
});

/**
 * Capitalised multi-word phrases these notes are allowed to carry. ONE entry, and it names a
 * competition class rather than a competitor: the league is published on the brief and in DESIGN.md,
 * and it identifies no match, no team and no day. Everything else capitalised in a note has to be
 * sentence-initial, which is the cheap shape guard below.
 */
const SANCTIONED_PHRASES = ['Small Size League'];

/** The chip sits inside a 390px panel and wraps rather than truncating; two lines is the budget. */
const NOTE_MAX_CHARS = 72;
const MP4_MAX_BYTES = 5 * 1024 * 1024;
const POSTER_MAX_BYTES = 200 * 1024;

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const section = (name) => console.log(`\n${name}`);

applySslSideModule(ROBOTS_BY_ID.get('ssl'));
applyDonnaExperience(ROBOTS_BY_ID.get('donna'));

/** A declared src/poster, as a repo path. The defs build these against `import.meta.url`. */
function toPath(value) {
  const text = String(value);
  if (text.startsWith('file:')) return fileURLToPath(text);
  return path.resolve(DEMO, text.replace(/^\/?demo\//, ''));
}

function sizeOf(abs) {
  return existsSync(abs) ? statSync(abs).size : -1;
}

// ------------------------------------------------------------------ 1. declarations and media

for (const mission of MISSIONS) {
  section(`${mission} footage declaration`);
  const def = ROBOTS_BY_ID.get(mission);
  const footage = def && def.experience && def.experience.success && def.experience.success.footage;
  ok(!!def, `${mission} resolves from ROBOTS_BY_ID`);
  ok(!!footage, `${mission} declares experience.success.footage`);
  if (!footage) continue;

  ok(typeof footage.src === 'string' && !!footage.src.trim(), `${mission} footage carries a src`);
  ok(typeof footage.poster === 'string' && !!footage.poster.trim(), `${mission} footage carries a poster`);
  ok(typeof footage.note === 'string' && !!footage.note.trim(), `${mission} footage carries a note`);

  // The success window, camera and labels are the FALLBACK the step runs when the media does not
  // arrive, so declaring footage may never replace them.
  const success = def.experience.success;
  ok(
    Array.isArray(success.window) && success.window.length === 2,
    `${mission} keeps its success window as the fail-open replay span`,
  );

  const video = toPath(footage.src);
  const poster = toPath(footage.poster);
  const videoBytes = sizeOf(video);
  const posterBytes = sizeOf(poster);
  const rel = (abs) => path.relative(DEMO, abs);

  ok(videoBytes >= 0, `${mission} footage src exists on disk (${rel(video)})`);
  ok(posterBytes >= 0, `${mission} footage poster exists on disk (${rel(poster)})`);
  ok(!rel(video).startsWith('..'), `${mission} footage src is served from inside demo/ (${rel(video)})`);
  ok(!rel(poster).startsWith('..'), `${mission} footage poster is served from inside demo/ (${rel(poster)})`);
  ok(
    videoBytes >= 0 && videoBytes <= MP4_MAX_BYTES,
    `${mission} footage is ${(Math.max(videoBytes, 0) / 1024 / 1024).toFixed(2)} MB, at or under the ${MP4_MAX_BYTES / 1024 / 1024} MB autoplay budget`,
  );
  ok(
    posterBytes >= 0 && posterBytes <= POSTER_MAX_BYTES,
    `${mission} poster is ${Math.round(Math.max(posterBytes, 0) / 1024)} KB, at or under the ${POSTER_MAX_BYTES / 1024} KB budget`,
  );
  ok(path.extname(video) === '.mp4', `${mission} footage src is an mp4 (${path.basename(video)})`);
  ok(path.extname(poster) === '.jpg', `${mission} poster is a jpg (${path.basename(poster)})`);
  // The FILENAME is a published string too: `ssl-leak-check.mjs` scans every tracked path as its own
  // unit of text, so a clip named after where it was filmed leaks by existing.
  ok(
    new RegExp(`^flow-${mission}\\.mp4$`).test(path.basename(video)),
    `${mission} footage filename is the mission id and nothing else (${path.basename(video)})`,
  );
  ok(
    new RegExp(`^flow-${mission}-poster\\.jpg$`).test(path.basename(poster)),
    `${mission} poster filename is the mission id and nothing else (${path.basename(poster)})`,
  );
}

// ------------------------------------------------------------------ 2. honesty copy

section('footage notes are honest and name nobody');
for (const mission of MISSIONS) {
  const def = ROBOTS_BY_ID.get(mission);
  const footage = (def && def.experience && def.experience.success && def.experience.success.footage) || {};
  const note = typeof footage.note === 'string' ? footage.note : '';
  ok(note === NOTES[mission], `${mission} note is the allowlisted string ("${note}")`);
  ok(/not the logged/i.test(note), `${mission} note says outright that this is not the logged mission`);
  ok(note.length <= NOTE_MAX_CHARS, `${mission} note fits the chip (${note.length}/${NOTE_MAX_CHARS} chars)`);
  ok(!/[—–]/.test(note), `${mission} note has no em or en dash`);

  // Cheap proper-name shape guard: strip the sanctioned phrases, then every remaining capitalised
  // word has to open a sentence. Two capitalised words in a row is what a team, an event or a venue
  // looks like, and none of those may ever appear here.
  let stripped = note;
  for (const phrase of SANCTIONED_PHRASES) stripped = stripped.split(phrase).join('');
  const runs = stripped.match(/\b[A-Z][A-Za-z]*(?:[ -][A-Z][A-Za-z]*)+/g) || [];
  ok(runs.length === 0, `${mission} note carries no unsanctioned capitalised phrase (${runs.join(' | ') || 'none'})`);
  const stray = (stripped.match(/(?:[a-z,]\s+)([A-Z][a-z]+)/g) || []).filter((hit) => !/\bNot\b/.test(hit));
  ok(stray.length === 0, `${mission} note capitalises nothing mid-sentence (${stray.join(' | ') || 'none'})`);
}

// ------------------------------------------------------------------ 3. footage is optional

section('footage is optional and every def without it is untouched');
const declared = ROBOTS.filter(
  (def) => !!(def.experience && def.experience.success && def.experience.success.footage),
).map((def) => def.id);
ok(
  JSON.stringify(declared.slice().sort()) === JSON.stringify(MISSIONS.slice().sort()),
  `exactly the four public missions declare footage (${declared.join(', ') || 'none'})`,
);

const battle = ROBOTS_BY_ID.get('battle');
ok(!!battle, 'the battle def resolves');
ok(
  !(battle && battle.experience && battle.experience.success && battle.experience.success.footage),
  'battle declares no footage key at all',
);
ok(
  !JSON.stringify(battle && battle.experience ? battle.experience : {}).includes('footage'),
  'nothing anywhere in the battle experience block mentions footage',
);

// ------------------------------------------------------------------ 4. the flow's wiring, on source

section('core/flow.js treats footage as optional and fails open');
const flow = readFileSync(FLOW_JS, 'utf8');
/** The same source with its prose removed, for the assertions that count real reads. */
const flowCode = flow
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

// EVERY READ IS GUARDED, and the way to prove it cheaply is that there is only ONE read. A single
// property access, inside a helper that answers null for a def that does not declare the key, is
// what makes "battle behaves exactly as it did" a structural fact rather than a claim.
const reads = (flowCode.match(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.footage\b/g) || []);
ok(
  reads.length === 1 && reads[0] === 'experience.success.footage',
  `flow.js reads the footage key exactly once, through the guarded chain (${reads.join(', ') || 'none'})`,
);
ok(
  flowCode.includes('experience && experience.success && experience.success.footage'),
  'the one read is guarded on the experience and on the success block',
);
ok(
  flow.includes('if (!footage || !footage.src || !footage.poster) return null;'),
  'a footage block without both a src and a poster is refused',
);
ok(
  /const footage = nextStep === 'mission' \? footageFor\(experience\) : null;/.test(flow),
  'only the mission step resolves footage; the anatomy and failure steps cannot see it',
);
ok(flow.includes('if (!footage) hideFootage();'), 'a step without footage tears the layer down');
ok(
  /function applyPlayback\(nextStep, experience, footage\)/.test(flow) && /\n    if \(footage\) \{/.test(flow),
  'applyPlayback takes footage as an argument and branches on it before it builds a viewer',
);

// FAIL OPEN, one assertion per link: the listener exists, it is the video that carries it, the
// handler retires the footage for the session, and it re-renders the mission step - which is the
// step running exactly as it ran before this round.
ok(
  flow.includes("video.addEventListener('error', onFootageError)"),
  "the footage video carries an 'error' listener",
);
ok(
  flow.includes("footageVideo.removeEventListener('error', onFootageError)"),
  "the 'error' listener is removed when the layer is torn down",
);
ok(/function onFootageError\(\) \{/.test(flow), 'the fail-open handler exists');
ok(
  /onFootageError\(\) \{[\s\S]*?footageGaveUp = true;[\s\S]*?hideFootage\(\);[\s\S]*?render\('mission', \{ refresh: true \}\);/.test(flow),
  'the handler retires the footage for the session and re-renders the mission step as the sim',
);
ok(
  /if \(footageGaveUp\) return null;/.test(flow),
  'a retired footage layer is never resolved again for this flow instance',
);
ok(
  /if \(footageVideo\.error\) onFootageError\(\);/.test(flow),
  'a play() rejection with a media error behind it also fails open',
);

// The reduced-motion contract: no autoplay, the poster stands as the step, and the existing play
// button starts the video instead of the success loop.
ok(
  /startFootage\(footage\) \{[\s\S]*?if \(reducedMotion\(\)\) \{[\s\S]*?play\.hidden = false;/.test(flow),
  'reduced motion holds the poster and exposes the play button',
);
ok(
  /function onPlay\(\) \{[\s\S]*?if \(footageLive && footageVideo\) \{[\s\S]*?playFootage\(\);/.test(flow),
  'the play button is step-aware: it starts the footage when the footage is what is on screen',
);

// The layer is built by JS on the first footage step, so a def without footage pays nothing, and the
// element is mounted in the PANEL rather than in the viewer mount - which `disposeViewer()` empties
// on every `refreshPayload()`.
ok(
  /viewerMount\.closest\('\.flow-viewer-frame'\)/.test(flow),
  'the layer mounts in the replay panel, not inside the viewer mount refreshPayload() empties',
);
ok(/if \(footageVideo\) return footageVideo;/.test(flow), 'the video element is built once and reused across steps');
ok(/hideFootage\(true\);/.test(flow), 'teardown removes the element as well as its listener');
ok(
  /timeline\.setLoop\(null, \{ speed: 1 \}\);\n      timeline\.pause\(\);\n      startFootage\(footage\)/.test(flow),
  'a footage step pauses the mission clock instead of running the success loop',
);

// The flow owns no clock. Round 11 adds a media element, which has its own, and that is exactly why
// this stays asserted: no timer, no interval, no animation frame.
ok(
  !/\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/.test(flowCode),
  'flow.js still owns no timer and no animation frame',
);

// ------------------------------------------------------------------ 5. the panel's CSS

section('index.html paints the layer over the whole panel');
const html = readFileSync(INDEX_HTML, 'utf8');
ok(html.includes('.flow-footage {'), 'the footage layer has a base rule');
ok(/\.flow-footage \{[^}]*display: none;/.test(html), 'the layer is inert until a footage step turns it on');
ok(/\.flow-footage-video \{[^}]*object-fit: cover;/.test(html), 'the video covers the panel');
ok(html.includes('.flow-footage-note {'), 'the honesty chip has a rule of its own');
ok(
  html.includes('#screen-flow .flow.has-footage[data-step="mission"] .flow-viewer-mount'),
  'a footage step hides the 3D viewer mount',
);
ok(
  html.includes('#screen-flow .flow.has-footage[data-step="mission"] .flow-context { display: none; }'),
  'a footage step hides the contextual labels, which quote this log rather than the footage',
);
ok(
  /#screen-flow \.flow\.has-footage\[data-step="mission"\] \.flow-viewer-frame \{[^}]*aspect-ratio: 16 \/ 9;/.test(html),
  'the panel is shaped to the 16:9 source rather than to the 3D camera cap',
);
// ssl's mission step carries a 4:5 aspect cap for its own reasons (the viewer's fov compensation).
// The footage rule has to outrank it, and with equal specificity that means LATER in the sheet.
const sslCap = html.indexOf('#screen-flow[data-flow-mission="ssl"] .flow[data-step="mission"] .flow-viewer-frame');
const footageCap = html.indexOf('#screen-flow .flow.has-footage[data-step="mission"] .flow-viewer-frame');
ok(sslCap > 0 && footageCap > sslCap, `the footage panel rule is declared after ssl's 4:5 cap (${sslCap} < ${footageCap})`);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
