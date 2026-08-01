// ssl-leak-check.mjs - the de-identification gate for everything this site SERVES, and for
// everything the public repository PUBLISHES.
//
//   node demo/js/robots/gen-fixture/ssl-leak-check.mjs                  deployment surface, manifest REQUIRED
//   node demo/js/robots/gen-fixture/ssl-leak-check.mjs --repo            every tracked file, manifest REQUIRED
//   node demo/js/robots/gen-fixture/ssl-leak-check.mjs --manifest <path> explicit manifest
//   node demo/js/robots/gen-fixture/ssl-leak-check.mjs --dev-partial     generic rules only
//   node demo/js/robots/gen-fixture/ssl-leak-check.mjs --self-test       adversarial fixtures only
//
// TWO SURFACES, BOTH GATED, because they are not the same set and the smaller one is not the
// dangerous one. The deployment surface is what Cloudflare uploads; the repository is what anyone
// can clone. `.assetsignore` excludes this whole directory, the design docs and the worker from the
// upload - and every one of them is committed. A gate that ran only over the upload could not see
// its own file, which is how a de-identification checker came to name both source teams in its own
// comments and pass itself. `npm test` runs BOTH modes.
//
// The SSL mission replays a real professional match under fictional team names. The deal that
// makes that honest is written down in the plan: the public assets carry NO source-to-match
// mapping. No archive URL, no log hash, no event, match or window identifier, no producer UUID,
// no real team name - only a dataset content hash and the phrase "a professional SSL match, 2026
// season". Everything that identifies the source lives in the PRIVATE manifest in the clients/alloy
// scratch repo.
//
// THIS FILE NAMES NONE OF IT. That is the property to preserve when editing it, and the version
// before this one broke it: its examples and its doc comments named BOTH source teams, which is
// the pairing, and `.assetsignore` kept the whole directory out of the only scan that ran. A gate
// that hardcodes the strings it is looking for publishes them - this file is committed to a
// repository that will be public, and a list of real team names in a de-identification checker is
// a de-identification failure with an explanation attached. EVERY organisation named anywhere
// below is INVENTED (KrellTech, NovaBots, Orbitwerks, Someplace Arena); they carry the SHAPES real
// names have, which is what the rules key on, and they name nobody. Every match-identifying needle
// is DERIVED FROM THE MANIFEST AT RUNTIME. The only vocabulary written down here is ordinary
// competition English ("match", "division", "season") which names no match, plus the word "final",
// which is ordinary English and is handled by its own proximity rule.
//
// FAIL-CLOSED, TWICE. Without the manifest the derived half cannot run, and a gate that cannot run
// is not a pass: the default invocation - the one `npm test` uses - EXITS NON-ZERO when the
// manifest is not on disk. And EVERY LEAF OF THE MANIFEST MUST BE IN MANIFEST_SCHEMA BY ITS EXACT
// PATH. A leaf with no schema entry fails the run by name, because a field nobody has said anything
// about is not a cleared field, it is an unread one.
//
// EXACT LEAVES, NOT SUBTREES. The version before this one classified by regex, and five of those
// regexes were subtree wildcards - `emitted.`, `source.renameMap.`, `exporter.config.teams.`,
// `exporter.config.vision.`, `gates.` - which certified as public not the leaves anyone had looked
// at but every leaf that would ever land underneath them. `emitted.sourceLog` or
// `exporter.config.teams.blue.originalName` would have been published with a rubber stamp already
// attached. There is no wildcard in the schema now: every public leaf is enumerated by full path,
// with its expected type and, where a value can be checked at all, a validator (the rename map has
// to carry the FICTIONAL names, a hull colour has to be a hex triplet, a gate has to be a number).
// `--self-test` plants an unknown leaf inside each of those five formerly-wildcarded subtrees and
// requires every one of them to come back unclassified.
//
// The four classes the version before THAT skipped outright - booleans, strings under four
// characters, numbers outside a hard-coded path list, and every comment field - have a fixture
// each, still. `--dev-partial` is the developer escape hatch: generic rules alone, says so loudly,
// and is deliberately not what the acceptance command calls.
//
// WHAT IS SCANNED. In the default mode: everything `.assetsignore` would let Cloudflare upload,
// parsed below, because that is what decides what is served. Plus EXTRA_SCAN: files that
// `.assetsignore` excludes from the upload but whose CONTENT still reaches a visitor - the analyst
// facts pack and the chat worker are served to the browser through an API response rather than as
// a file, and a leak in a facts pack is a leak on the page. In `--repo` mode: every path
// `git ls-files` reports, which is the whole published repository and a strict superset. And in
// both modes each file's own PATH, as a second unit of text: a file called `<team>-hero.png`
// publishes the team name to everyone who opens it, and reading its bytes will never say so.
//
// RAW BYTES, NOT JUST TEXT. There is no "this file is binary, skip it" branch. Every file is
// scanned as UTF-8, and a file carrying a NUL byte is scanned a SECOND time as a raw byte string
// (latin1), because an identifier sitting in a PNG comment, an ICO header or any other container
// is an identifier the clone carries. The version before this one returned null the moment it saw
// a NUL and adjudicated nothing in that file at all, which made "fail closed" a claim about text
// files only.
//
// Exits 0 when nothing leaks.

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const argv = process.argv.slice(2);
const argManifest = argv.includes('--manifest') ? argv[argv.indexOf('--manifest') + 1] : null;
const DEV_PARTIAL = argv.includes('--dev-partial');
/** Scan every tracked path instead of the deployment surface. See the header. */
const REPO_MODE = argv.includes('--repo');
/** Adversarial fixtures for the classes this gate used to skip. See the block at the bottom. */
const SELF_TEST = argv.includes('--self-test');
/**
 * The private manifest. Repo-tracked script, untracked path: this file is committed, the manifest
 * it reads is not, and never can be. Overridable so the exporter session can point at a re-emit.
 */
const MANIFEST =
  argManifest ||
  process.env.SSL_MATCH_MANIFEST ||
  path.join(
    process.env.HOME || '',
    'Documents/alloy-ssl-exporter-worktree/reels/_scratch/ssl-mujoco/out/match-manifest.json',
  );

let failures = 0;
let checks = 0;
const fail = (msg) => {
  failures++;
  console.error(`  LEAK  ${msg}`);
};

// ---------------------------------------------------------------- what is served

/**
 * Files that `.assetsignore` keeps off the CDN but whose content still reaches a visitor. The
 * worker directory is not uploaded as static assets; it runs, and it puts what is below in front
 * of the analyst, which puts it in front of the person asking. Scanning only what Cloudflare
 * uploads was a hole big enough to drive the whole facts pack through.
 */
const EXTRA_SCAN = [
  ['worker/facts.generated.js', 'the analyst facts pack, streamed into every answer'],
  ['worker/chat.js', 'the chat worker, which composes what the analyst is told'],
];

/**
 * Files whose content is machine-generated and whose "lines" are megabyte-scale, so an approved
 * occurrence is anchored on a WINDOW around the hit rather than on the whole line. See unitOf().
 */
const MEGALINE = [/^worker\/facts\.generated\.js$/];

/**
 * .assetsignore, gitignore syntax. A pattern with a slash in it is anchored to the repo root; one
 * without matches any path SEGMENT at any depth. `*` is the only wildcard in this file.
 */
function loadIgnore(root = ROOT) {
  const raw = readFileSync(path.join(root, '.assetsignore'), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((p) => p.replace(/\/$/, ''))
    .map((p) => ({
      pat: p,
      anchored: p.includes('/'),
      re: p.includes('*')
        ? new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
        : null,
    }));
}

function isIgnored(rel, rules) {
  const segs = rel.split('/');
  for (const r of rules) {
    if (r.anchored) {
      if (rel === r.pat || rel.startsWith(`${r.pat}/`)) return true;
    } else if (r.re) {
      if (segs.some((s) => r.re.test(s))) return true;
    } else if (segs.includes(r.pat)) {
      return true;
    }
  }
  return false;
}

/** Everything Cloudflare would upload, plus the reaches-the-visitor extras. */
function surfaceFiles(root = ROOT) {
  const rules = loadIgnore(root);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs);
      if (isIgnored(rel, rules)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(rel);
    }
  };
  walk(root);
  for (const [rel] of EXTRA_SCAN) {
    if (existsSync(path.join(root, rel)) && !out.includes(rel)) out.push(rel);
  }
  return out.sort();
}

/**
 * EVERY TRACKED PATH. Not a superset of the deployment surface by accident: it is the surface the
 * acceptance contract actually names, because a public repository is published to everyone who can
 * clone it and `.assetsignore` has no authority there at all. `git ls-files` rather than a walk, so
 * an untracked scratch file in the working tree is not mistaken for something the world can see -
 * and so a file this gate excludes from the upload but git carries anyway is scanned by exactly the
 * rule that says why it matters.
 */
function repoFiles(root = ROOT) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  // A tracked path can be deleted in the working tree; there is nothing to read and nothing to leak.
  return out.filter((rel) => existsSync(path.join(root, rel))).sort();
}

/**
 * The UNITS of text one file contributes. Always UTF-8, because that is what copy is. Plus, when
 * the file carries a NUL byte, the same bytes as latin1: a NUL means the decoder is going to hand
 * back replacement characters for anything it cannot map, and an ASCII identifier sitting between
 * two of them would be adjudicated against a string that no longer contains it. latin1 is the
 * identity byte-to-char mapping, so that second pass is literally "scan the raw bytes".
 *
 * There is no skip branch. A binary has no COPY in it, which is not the same claim as having no
 * identifier in it: PNG text chunks, ICO headers, font name tables and embedded EXIF all carry
 * strings, and the version of this gate that returned null on the first NUL adjudicated zero
 * candidate occurrences in every one of them.
 *
 * @returns {Array<{label:string, text:string}>}
 */
function unitsOf(rel, buf) {
  const text = buf.toString('utf8');
  const units = [{ label: rel, text }];
  if (buf.includes(0)) {
    const bytes = buf.toString('latin1');
    // For a pure-ASCII file the two decodes are the same string and a second pass is pure noise.
    if (bytes !== text) units.push({ label: `${rel} (raw bytes)`, text: bytes });
  }
  return units;
}

const readBytes = (root, rel) => readFileSync(path.join(root, rel));

// ---------------------------------------------------------------- forbidden strings

/** Accent-fold and case-fold, so `KrellTéch` and `krelltech` are the same needle. */
const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * THE LEAF SCHEMA. Every leaf of the manifest must appear here BY ITS EXACT PATH, and a leaf that
 * does not FAILS THE RUN. That is the whole default-forbid claim, made real.
 *
 * There are no subtree wildcards. There used to be five - `emitted.`, `source.renameMap.`,
 * `exporter.config.teams.`, `exporter.config.vision.`, `gates.` - and each of them certified as
 * public every leaf that would ever land underneath it, not the leaves anyone had read. A future
 * `emitted.sourceLog`, or an `originalName` on a team, would have arrived pre-cleared. Enumerating
 * the leaves is more to maintain and that is the feature: adding a field to the manifest is now a
 * decision someone has to write down here, with a reason, and a re-emit that quietly grows one is a
 * failing run with the path in the message.
 *
 * Array elements collapse to `#` (`source.epochs.#.t0`), which is the one generalisation made: an
 * array is homogeneous by construction, so the schema describes its element, not its length.
 *
 * Each entry is `{ kind, type, why, check? }`:
 *
 *   kind         public | identifier | locator | measurement | prose (see below)
 *   type         'string' | 'number' | 'boolean' - a leaf of the wrong type fails, because a field
 *                that changed shape is a field nobody has re-read
 *   check(v, m)  optional value validator; returns null when fine, or the reason it is not. `m` is
 *                the whole manifest, so a leaf can be checked against another one
 *
 *   public       no needle. Published on purpose, or names nothing.
 *   identifier   whole value + percent-decoded + tokens. Match-identifying text.
 *   locator      a number that locates the window inside the source log.
 *   measurement  a number or boolean about the ENCODE or the log's shape. No needle.
 *   prose        free text. Scanned for identifier SHAPES rather than tokenised - see proseNeedles.
 */

const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Validators, named so the schema below reads as a table rather than as a wall of closures. */
const V = {
  nonEmpty: (v) => (String(v).trim().length > 0 ? null : 'is empty'),
  hexColour: (v) => (HEX_COLOUR.test(v) ? null : `is not a #rrggbb colour: ${v}`),
  sha256: (v) => (SHA256_HEX.test(v) ? null : 'is not a sha256 hex digest'),
  positive: (v) => (Number.isFinite(v) && v > 0 ? null : `is not a positive number: ${v}`),
  nonNegative: (v) => (Number.isFinite(v) && v >= 0 ? null : `is not a non-negative number: ${v}`),
  percent: (v) => (Number.isFinite(v) && v >= 0 && v <= 100 ? null : `is not a percentage: ${v}`),
  finite: (v) => (Number.isFinite(v) ? null : `is not a finite number: ${v}`),
  /**
   * The rename map has to carry the FICTIONAL names - the ones the config publishes - and must
   * never carry the real one. This is the single most consequential value in the manifest: it is
   * the whole de-identification, written as two strings, and a typo in it publishes a real team.
   */
  fictionalName: (v, m, p) => {
    const colour = p.split('.').pop();
    const want = m?.exporter?.config?.teams?.[colour]?.displayName;
    const real = m?.source?.realTeamNames?.[colour];
    if (typeof want === 'string' && v !== want)
      return `is not the fictional display name the config publishes (${want})`;
    if (typeof real === 'string' && fold(v) === fold(real)) return 'IS THE REAL TEAM NAME';
    return null;
  },
  /** A published team string must not be the real name under any folding. */
  notRealName: (v, m, p) => {
    const colour = p.split('.')[3];
    const real = m?.source?.realTeamNames?.[colour];
    if (typeof real !== 'string') return null;
    return fold(real).includes(fold(v)) || fold(v).includes(fold(real))
      ? 'shares text with the real team name'
      : null;
  },
};

const pub = (why, type, check) => ({ kind: 'public', type, why, check });
const prose = (why) => ({ kind: 'prose', type: 'string', why });

const MANIFEST_SCHEMA = {
  // ---- top level
  '_comment.#': prose('the manifest saying out loud that it is private'),
  generatedUtc: pub('when the export ran, which locates no match', 'string', V.nonEmpty),
  datasetHash: pub('emitted as DATASET_HASH - the one public content hash', 'string', (v) =>
    /^sha256:[0-9a-f]{64}$/.test(v) ? null : 'is not a sha256: content hash'),
  formatVersion: pub('emitted as FORMAT_VERSION', 'number', (v) =>
    v === 1 ? null : `is not the format this gate was written against: ${v}`),

  // ---- source: what the export was made FROM. Almost all of it identifies the match.
  'source.archiveUrl': { kind: 'identifier', type: 'string', why: 'names the archive the log came from' },
  'source.archivePath': { kind: 'identifier', type: 'string', why: 'names the log inside the archive' },
  'source.logFile': { kind: 'identifier', type: 'string', why: 'names the log' },
  'source.logSha256': { kind: 'identifier', type: 'string', why: 'pins the exact log' },
  'source.producerUuid': { kind: 'identifier', type: 'string', why: 'names the producer' },
  'source.producerSourceName.#': { kind: 'identifier', type: 'string', why: "the producer's real source name" },
  'source.realTeamNames.yellow': { kind: 'identifier', type: 'string', why: 'the real team' },
  'source.realTeamNames.blue': { kind: 'identifier', type: 'string', why: 'the real team' },
  'source.match.event': { kind: 'identifier', type: 'string', why: 'names the event' },
  'source.match.match': { kind: 'identifier', type: 'string', why: 'names the match' },
  'source.match.recorded': { kind: 'identifier', type: 'string', why: 'when it was recorded' },
  'source.match.teams.yellow': { kind: 'identifier', type: 'string', why: 'the real team' },
  'source.match.teams.blue': { kind: 'identifier', type: 'string', why: 'the real team' },
  'source.match.officialScore': { kind: 'identifier', type: 'string', why: 'the real teams and the real result' },
  'source.match.division': pub(
    'the division is derivable from the rendered field geometry and is published on purpose',
    'string',
    V.nonEmpty,
  ),
  'source.window.tStartS': { kind: 'locator', type: 'number', why: 'the window bounds in the source log timebase' },
  'source.window.tEndS': { kind: 'locator', type: 'number', why: 'the window bounds in the source log timebase' },
  'source.window.axis': prose('names the clock the bounds are on'),
  'source.producerCapabilities.#': pub(
    'tracked-frame protocol enums every tracker declares; emitted in META beside the opaque tracker label',
    'string',
    V.nonEmpty,
  ),
  'source.epochs.#.t0': { kind: 'locator', type: 'number', why: 'the clock-epoch fit maps this window onto the log' },
  'source.epochs.#.t1': { kind: 'locator', type: 'number', why: 'the clock-epoch fit maps this window onto the log' },
  'source.epochs.#.offset_s': { kind: 'locator', type: 'number', why: 'absolute wall clock of the recording' },
  'source.epochs.#.slope': { kind: 'locator', type: 'number', why: 'part of the same fit' },
  'source.epochs.#.i0': { kind: 'measurement', type: 'number', why: 'frame index inside the exported window' },
  'source.epochs.#.i1': { kind: 'measurement', type: 'number', why: 'frame index inside the exported window' },
  'source.epochs.#.n': { kind: 'measurement', type: 'number', why: 'sample count, also in the public META' },
  'source.epochs.#.resid_rms_ms': { kind: 'measurement', type: 'number', why: 'fit residual' },
  'source.epochs.#.monotonic': { kind: 'measurement', type: 'boolean', why: 'fit validity flag' },
  'source.epochs.#.valid': { kind: 'measurement', type: 'boolean', why: 'fit validity flag' },
  'source.coverage.robot_vel_pct': pub('completeness of the export', 'number', V.percent),
  'source.coverage.robot_vel_angular_pct': pub('completeness of the export', 'number', V.percent),
  'source.coverage.robot_visibility_pct': pub('completeness of the export', 'number', V.percent),
  'source.coverage.ball_frame_pct': pub('completeness of the export', 'number', V.percent),
  'source.coverage.ball_vel_pct': pub('completeness of the export', 'number', V.percent),
  'source.coverage.ball_visibility_pct': pub('completeness of the export', 'number', V.percent),
  'source.coverage.kicked_ball_robot_id_pct': pub('completeness of the export', 'number', V.percent),
  'source.renameMap.yellow': pub('the FICTIONAL display name, which is the public one', 'string', V.fictionalName),
  'source.renameMap.blue': pub('the FICTIONAL display name, which is the public one', 'string', V.fictionalName),

  // ---- exporter: the checkout and the configuration it ran with
  'exporter.gitRevision': { kind: 'identifier', type: 'string', why: 'pins the private exporter checkout' },
  'exporter.sourceContentHash': { kind: 'identifier', type: 'string', why: 'pins the private exporter sources' },
  'exporter.gitDirty': pub('a boolean about the exporter checkout', 'boolean'),
  'exporter.sourceFiles.#': pub('names the producing script, published in the asset header', 'string', V.nonEmpty),
  'exporter.config._comment.#': prose('configuration commentary'),
  'exporter.config.configVersion': pub('schema version of the export config', 'number', V.positive),
  'exporter.config.log': { kind: 'identifier', type: 'string', why: 'the configured log file' },
  'exporter.config.canonicalProducerUuid': { kind: 'identifier', type: 'string', why: 'the accepted producer' },
  'exporter.config.window.tStart': { kind: 'locator', type: 'number', why: 'configured window bounds, log timebase' },
  'exporter.config.window.tEnd': { kind: 'locator', type: 'number', why: 'configured window bounds, log timebase' },
  'exporter.config.preview.tStart': { kind: 'locator', type: 'number', why: 'configured slice bounds, log timebase' },
  'exporter.config.preview.tEnd': { kind: 'locator', type: 'number', why: 'configured slice bounds, log timebase' },
  'exporter.config.publicTrackerLabel': pub('the opaque label, published on purpose', 'string', V.nonEmpty),
  'exporter.config.publicMatchDescription': pub('the generic description, published on purpose', 'string', V.nonEmpty),
  'exporter.config.teams.yellow.displayName': pub('fictional display name', 'string', V.notRealName),
  'exporter.config.teams.yellow.shortName': pub('fictional short name', 'string', V.notRealName),
  'exporter.config.teams.yellow.hull.bright': pub('hull palette', 'string', V.hexColour),
  'exporter.config.teams.yellow.hull.dark': pub('hull palette', 'string', V.hexColour),
  'exporter.config.teams.yellow.accent': pub('UI accent', 'string', V.hexColour),
  'exporter.config.teams.blue.displayName': pub('fictional display name', 'string', V.notRealName),
  'exporter.config.teams.blue.shortName': pub('fictional short name', 'string', V.notRealName),
  'exporter.config.teams.blue.hull.bright': pub('hull palette', 'string', V.hexColour),
  'exporter.config.teams.blue.hull.dark': pub('hull palette', 'string', V.hexColour),
  'exporter.config.teams.blue.accent': pub('UI accent', 'string', V.hexColour),
  'exporter.config._teams_comment.#': prose('team-block commentary'),
  'exporter.config.cadence.ballStride': pub('export cadence, emitted in the public META', 'number', V.positive),
  'exporter.config.cadence.robotStrideOverBall': pub('export cadence, emitted in META', 'number', V.positive),
  'exporter.config.cadence._comment.#': prose('cadence commentary'),
  'exporter.config.preview.ballStride': pub('preview cadence, public', 'number', V.positive),
  'exporter.config.preview.robotStrideOverBall': pub('preview cadence, public', 'number', V.positive),
  'exporter.config.preview._comment.#': prose('preview commentary'),
  'exporter.config.cameraFocus.targetSeconds': pub('focus smoothing, emitted in META', 'number', V.positive),
  'exporter.config.cameraFocus._comment.#': prose('focus commentary'),
  'exporter.config.quant.posScale': pub('quantisation scale, emitted in META', 'number', V.positive),
  'exporter.config.quant.velScale': pub('quantisation scale, emitted in META', 'number', V.positive),
  'exporter.config.quant.yawScale': pub('quantisation scale, emitted in META', 'number', V.positive),
  'exporter.config.quant.angVelScale': pub('quantisation scale, emitted in META', 'number', V.positive),
  'exporter.config.quant.timeScale': pub('quantisation scale, emitted in META', 'number', V.positive),
  'exporter.config.quant._comment.#': prose('quantisation commentary'),
  'exporter.config.absence.shortGapSeconds': pub('absence threshold, emitted in META', 'number', V.positive),
  'exporter.config.absence.substitutionEvidenceWindowSeconds': pub('absence threshold', 'number', V.positive),
  'exporter.config.absence._comment.#': prose('absence commentary'),
  'exporter.config.vision.crossCheckPad': pub('cross-check event-window padding', 'number', V.positive),
  'exporter.config.vision.binSeconds': pub('cross-check bin width, emitted in META', 'number', V.positive),
  'exporter.config.vision._comment': prose('cross-check commentary'),
  'exporter.config.gates.matchDataGzipMaxBytes': pub('size limit the export was held to', 'number', V.positive),
  'exporter.config.gates.previewRawMaxBytes': pub('size limit the export was held to', 'number', V.positive),
  'exporter.config.gates.decodeMaxMs': pub('decode-time limit', 'number', V.positive),
  'exporter.config.gates.posRmseMaxM': pub('fidelity limit', 'number', V.positive),
  'exporter.config.gates.speedRmseMaxMps': pub('fidelity limit', 'number', V.positive),
  'exporter.config.gates.peakAccelErrMaxFrac': pub('fidelity limit', 'number', V.positive),
  'exporter.config.gates.ballSpeedCapMps': pub('rules cap the export is checked against', 'number', V.positive),
  'exporter.config.gates.ballSpeedCapToleranceMps': pub('tolerance on that cap', 'number', V.positive),

  // ---- emitted: the two PUBLIC modules, described. Enumerated one leaf at a time on purpose:
  // this is the subtree a future `emitted.sourceLog` would have landed in pre-cleared.
  'emitted.matchDataPath': pub('the served path of the public module', 'string', V.nonEmpty),
  'emitted.matchDataRawBytes': pub('size of the public module', 'number', V.positive),
  'emitted.matchDataGzipBytes': pub('size of the public module', 'number', V.positive),
  'emitted.matchDataBlobSha256': pub('content hash of the PUBLIC blob', 'string', V.sha256),
  'emitted.previewDataRawBytes': pub('size of the public module', 'number', V.positive),
  'emitted.previewDataGzipBytes': pub('size of the public module', 'number', V.positive),
  'emitted.previewDataBlobSha256': pub('content hash of the PUBLIC blob', 'string', V.sha256),
  'emitted.cadence.ballFps': pub('cadence, emitted verbatim in the public META', 'number', V.positive),
  'emitted.cadence.robotFps': pub('cadence, emitted verbatim in the public META', 'number', V.positive),
  'emitted.cadence.ballStrideNativeFrames': pub('cadence, emitted in META', 'number', V.positive),
  'emitted.cadence.robotStrideNativeFrames': pub('cadence, emitted in META', 'number', V.positive),
  'emitted.cadence.nativeRateHz': pub('the producer rate, emitted in META', 'number', V.positive),
  'emitted.cameraFocus.grid': pub('which grid the focus track rides, emitted in META', 'string', V.nonEmpty),
  'emitted.cameraFocus.windowSamples': pub('focus window, emitted in META', 'number', V.positive),
  'emitted.cameraFocus.windowSeconds': pub('focus window, emitted in META', 'number', V.positive),
  // These two are the exact strings the export writes into the PUBLIC META, so scanning them as
  // prose fails on the very module they belong in. Public by construction, and only these two.
  'emitted.cameraFocus.method': pub('published verbatim in the public META', 'string', V.nonEmpty),
  'emitted.cameraFocus.note': pub('published verbatim in the public META', 'string', V.nonEmpty),

  // ---- gates: numbers about the ENCODE. They describe the pipeline and its output, not the match.
  'gates.pass': pub('did the export meet its own limits', 'boolean'),
  'gates.limits.matchDataGzipMaxBytes': pub('size limit', 'number', V.positive),
  'gates.limits.previewRawMaxBytes': pub('size limit', 'number', V.positive),
  'gates.limits.decodeMaxMs': pub('decode-time limit', 'number', V.positive),
  'gates.limits.posRmseMaxM': pub('fidelity limit', 'number', V.positive),
  'gates.limits.speedRmseMaxMps': pub('fidelity limit', 'number', V.positive),
  'gates.limits.peakAccelErrMaxFrac': pub('fidelity limit', 'number', V.positive),
  'gates.limits.ballSpeedCapMps': pub('rules cap', 'number', V.positive),
  'gates.limits.ballSpeedCapToleranceMps': pub('tolerance on that cap', 'number', V.positive),
  'gates.measured.matchDataGzipBytes': pub('measured size', 'number', V.positive),
  'gates.measured.previewRawBytes': pub('measured size', 'number', V.positive),
  'gates.measured.fidelity.heldOutRobotSamples': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.usableRobotPairs': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.posRmseM': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.posP99M': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.posMaxM': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.speedRmseMps': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.speedP99Mps': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.peakAccel.gateSpanS': pub('encode measurement', 'number', V.positive),
  'gates.measured.fidelity.peakAccel.gateSpanInExportIntervals': pub('encode measurement', 'number', V.positive),
  'gates.measured.fidelity.peakAccel.gateRationale': prose('why that span and not a shorter one'),
  // Referee colour + tracked id. Both are published in META and neither is ever altered.
  'gates.measured.fidelity.peakAccel.perRobot.#.robot': pub('referee colour + tracked id', 'string', (v) =>
    ROBOT_NAME.test(v) ? null : `is not a <colour><id> robot name: ${v}`),
  'gates.measured.fidelity.peakAccel.perRobot.#.nativeP995': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.peakAccel.perRobot.#.reconP995': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.peakAccel.perRobot.#.nativeMax': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.peakAccel.perRobot.#.reconMax': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.peakAccel.perRobot.#.relErrP995': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.peakAccel.worstRelErrP995': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.peakAccel.medianRelErrP995': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.peakAccel.sweep.#.#.halfWidthS': pub('encode measurement', 'number', V.positive),
  'gates.measured.fidelity.peakAccel.sweep.#.#.spanS': pub('encode measurement', 'number', V.positive),
  'gates.measured.fidelity.peakAccel.sweep.#.#.spanInExportIntervals': pub('encode measurement', 'number', V.positive),
  'gates.measured.fidelity.peakAccel.sweep.#.#.bandLimited': pub('encode measurement', 'boolean'),
  'gates.measured.fidelity.peakAccel.sweep.#.#.worstRelErrP995': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.peakAccel.sweep.#.#.medianRelErrP995': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.peakAccel.sweep.#.#.medianNativeP995Mps2': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.ball.heldOutSamples': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.speedCap.method': prose('how the observable speed was computed'),
  'gates.measured.fidelity.ball.speedCap.capMps': pub('rules cap', 'number', V.positive),
  'gates.measured.fidelity.ball.speedCap.toleranceMps': pub('tolerance on that cap', 'number', V.positive),
  'gates.measured.fidelity.ball.speedCap.comparedSamples': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.speedCap.referenceUnderCap': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.speedCap.referenceOverCap': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.speedCap.referenceOverCapNote': prose('what those over-cap samples are'),
  'gates.measured.fidelity.ball.speedCap.violations': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.speedCap.maxReconWhereReferenceUnderCap': pub('encode measurement', 'number', V.finite),
  'gates.measured.fidelity.ball.speedCap.observableSpeedRmseMps': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.speedCap.pass': pub('gate outcome', 'boolean'),
  'gates.measured.fidelity.ball.shippedCadenceIsNative': pub('gate outcome', 'boolean'),
  'gates.measured.fidelity.ball.quantisationOnlyPosRmseM': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ball.quantisationOnlyPosMaxM': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.heldOutSamples': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.usableSamples': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.excludedSamples': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.posRmseM': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.posP99M': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.posMaxM': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.speedRmseMps': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.nativeUnderCap': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.nativeOverCap': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.capViolations': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.fidelity.ballHalfCadenceBound.maxReconSpeedWhereNativeUnderCap': pub(
    'encode measurement', 'number', V.finite),
  'gates.measured.fidelity.ballHalfCadenceBound.note': prose('what that pessimistic bound is'),
  'gates.measured.yaw.rawBoundaryCrossings': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.yaw.crossingsResolvedByUnwrap': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.yaw.exportedStepsOverPi': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.yaw.worstRewrapErrorRad': pub('encode measurement', 'number', V.nonNegative),
  'gates.measured.yaw.quantisationRad': pub('encode measurement', 'number', V.positive),
  'gates.measured.yaw.pass': pub('gate outcome', 'boolean'),
};

/**
 * A leaf path with every array index collapsed to `#`. The ONLY generalisation the schema makes,
 * and it is a safe one: an array is homogeneous by construction, so describing its element
 * describes every element. Object keys are never collapsed - that is where a new field hides.
 */
const schemaPath = (p) => p.replace(/(^|\.)\d+(?=\.|$)/g, '$1#');

/** The schema entry for one manifest leaf, or null when nobody has said what it is. */
function classify(p) {
  return Object.prototype.hasOwnProperty.call(MANIFEST_SCHEMA, schemaPath(p))
    ? MANIFEST_SCHEMA[schemaPath(p)]
    : null;
}

/**
 * Does this leaf's VALUE match what the schema says it is? Type first, then the optional validator.
 * A leaf whose type changed is a leaf nobody has re-read, and the classification it inherited was
 * written about something else.
 *
 * @returns {string|null} the reason it does not, or null
 */
function validateLeaf(entry, path, value, manifest) {
  const t = typeof value;
  if (entry.type && t !== entry.type) return `is a ${t}, schema says ${entry.type}`;
  if (entry.check) {
    try {
      return entry.check(value, manifest, path) || null;
    } catch (err) {
      return `value validator threw: ${err && err.message}`;
    }
  }
  return null;
}

/**
 * Manifest paths that MUST exist. This is the answer to "the derivation quietly skipped a field":
 * if the manifest is re-emitted with a renamed or dropped identifier, the gate fails instead of
 * passing with a smaller forbidden list. Paths only - no values.
 */
const REQUIRED_MANIFEST_PATHS = [
  'source.archiveUrl',
  'source.archivePath',
  'source.logFile',
  'source.logSha256',
  'source.producerUuid',
  'source.producerSourceName',
  'source.realTeamNames',
  'source.window.tStartS',
  'source.window.tEndS',
  'source.match.event',
  'source.match.match',
  'source.match.division',
  'source.match.recorded',
  'source.match.teams',
  'source.match.officialScore',
  'source.epochs',
  'exporter.gitRevision',
  'exporter.sourceContentHash',
  'exporter.config.log',
  'exporter.config.window.tStart',
  'exporter.config.canonicalProducerUuid',
];

/**
 * Tokens that identify nothing and would fire on ordinary copy. Every entry is a word this site is
 * ALLOWED to say: the division is derivable from the rendered field and is published, the season is
 * published, and the rest is URL and filesystem furniture.
 */
const GENERIC_TOKENS = new Set([
  'http',
  'https',
  'file',
  'files',
  'path',
  'division',
  // the abbreviation the archive path and the page's own hardware line both use. Same published
  // fact as "division": it is derivable from the rendered field geometry and is on the brief.
  'div',
  'season',
  'local',
  'time',
  'relative',
  'receive',
  'sha256',
  '2026',
  // ordinary English that happens to sit inside an archive path. "phase" names no phase and
  // "final" is owned by the F1/F2 proximity rules below, which is a stricter test than a needle:
  // a needle would have to fire on every "final panel rect" in the stylesheet.
  'phase',
  'final',
  'finals',
  // Short tokens a URL and a log filename leave behind. Each names nothing, and each is short
  // enough that a context-scanned needle for it would fire on ordinary code and copy.
  'gz',
  'js',
  'vs',
  'log',
  'logs',
  'de',
  'us',
  'in',
  'at',
  'to',
  'of',
  'is',
  'as',
  'on',
  'or',
  'by',
]);

/** Referee colour + tracked id. Published on purpose: those two are never altered. */
const ROBOT_NAME = /^(yellow|blue)\d+$/i;

/** Every scalar leaf of an object, as `[dottedPath, value]`. */
function leaves(o, p = '', out = []) {
  if (o === null || o === undefined) return out;
  if (Array.isArray(o)) o.forEach((v, i) => leaves(v, p ? `${p}.${i}` : String(i), out));
  else if (typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) leaves(v, p ? `${p}.${k}` : k, out);
  } else out.push([p, o]);
  return out;
}

const hasPath = (o, dotted) => {
  let cur = o;
  for (const k of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return false;
    cur = cur[k];
  }
  return cur !== null && cur !== undefined;
};

/**
 * SHAPES that identify an organisation rather than describe one. Both halves of the manifest's
 * prose were measured before these were chosen, and neither fires on a single token of it.
 *
 * The examples are INVENTED, and have to be: an example in a de-identification checker is published
 * with it. They carry the two shapes, which is all an example is for here.
 *
 *   MIXED_CAPS   `KrellTech`, `NovaBots` - a capital, lowercase, then another capital.
 *   LEADING_CAPS `ORBITwerks`, `KRELLtech` - a run of capitals, then lowercase.
 *
 * Deliberately NOT "any capitalised word": the manifest's comments open sentences, so `Identifies`,
 * `Strides` and `Everything` are all in there and every one of them would be a needle firing on
 * ordinary copy. Deliberately NOT "any interior capital" either: that is camelCase, and the
 * comments quote `ballStride` and `timeScale`, which are published in META.
 *
 * The honest limit: a single plain-capitalised proper noun in a comment and NOWHERE ELSE in the
 * manifest is not caught by shape. It is caught in practice because the identifier it names is
 * also in a real field, and REQUIRED_MANIFEST_PATHS is what fails the run if those fields go
 * missing. Every real team name in this league has one of the two shapes above.
 */
const MIXED_CAPS = /^[A-Z][a-z][A-Za-z]*[A-Z]/;
const LEADING_CAPS = /^[A-Z]{2,}[a-z]/;
const identifierShaped = (t) => MIXED_CAPS.test(t) || LEADING_CAPS.test(t);

/** A UUID anywhere in a string, whatever key it hides under. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** An ISO day, which is what a search for a recording would actually match. */
const DAY_RE = /\d{4}-\d{2}-\d{2}/;
/** A content hash long enough to be one. */
const HASH_RE = /\b[0-9a-f]{16,}\b/i;

/**
 * The needles, every one of them derived from the manifest.
 *
 * Three kinds, and the difference is how hard a hit has to work to be a leak:
 *
 *   `exact`    a literal substring after folding. For whole values and long compounds, which are
 *              long enough that a substring match is the right test.
 *   `word`     needs boundaries either side, so a token does not fire inside a longer word or a
 *              base64 run. For tokens of four characters or more.
 *   `context`  needs boundaries AND a competition word within 80 characters. This is what makes
 *              SHORT tokens and BARE NUMBERS scannable at all: "div", "vs" and "1854" are noise in
 *              a stylesheet and identifying beside the word "match", and the old gate answered that
 *              by not scanning them. Same proximity test the F1 rule for "final" has used all
 *              along, which is a stricter test than a needle, not a weaker one.
 *
 * A term derived twice keeps the STRICTER kind: deriving "KrellTech" as a context needle from one
 * field must not weaken the unconditional needle another field already produced.
 */
function buildNeedles(manifest) {
  const needles = [];
  const byTerm = new Map();
  const RANK = { context: 1, word: 2, exact: 3 };
  const add = (term, why, kind = 'exact', min = 4) => {
    const s = String(term == null ? '' : term).trim();
    if (s.length < min) return;
    const f = fold(s);
    const prev = byTerm.get(f);
    if (prev) {
      if (RANK[kind] > RANK[prev.kind]) {
        prev.kind = kind;
        prev.why = why;
      }
      return;
    }
    const n = { term: s, folded: f, why, kind };
    byTerm.set(f, n);
    needles.push(n);
  };

  /** A token from an identifier: unconditional at four characters, context-scanned below that. */
  const addToken = (t, why) => {
    if (!t || GENERIC_TOKENS.has(t.toLowerCase()) || ROBOT_NAME.test(t)) return;
    if (/^\d+$/.test(t)) return;
    if (t.length >= 4) add(t, `${why}, token`, 'word');
    else add(t, `${why}, short token`, 'context', 2);
  };

  /**
   * A number that could locate or identify. Both the value as written and its integer part: a
   * served file is as likely to carry `4711` as `4711.5`. Context-scanned unless it is long
   * enough to be an identifier on its own. (The example is INVENTED, like every other in this
   * file: the previous one was the manifest's real window start, written out in a comment.)
   */
  const addNumber = (v, why) => {
    const s = String(v);
    add(s, why, s.replace(/\D/g, '').length >= 6 ? 'word' : 'context', 2);
    const whole = s.split('.')[0].replace(/^-/, '');
    if (whole && whole !== s) add(whole, `${why}, integer part`, 'context', 2);
  };

  /** Identifier shapes, dates, UUIDs and hashes out of free text. Never ordinary words. */
  const proseNeedles = (s, why) => {
    add(s, `${why}, verbatim`, 'exact', 24);
    const uuid = UUID_RE.exec(s);
    if (uuid) add(uuid[0], `${why}, UUID`);
    const day = DAY_RE.exec(s);
    if (day) add(day[0], `${why}, date`, 'word');
    const hash = HASH_RE.exec(s);
    if (hash) add(hash[0], `${why}, content hash`);
    for (const t of s.split(/[^\p{L}\p{N}]+/u)) {
      if (!t || GENERIC_TOKENS.has(t.toLowerCase()) || ROBOT_NAME.test(t)) continue;
      if (identifierShaped(t)) add(t, `${why}, identifier-shaped token`, 'word', 2);
    }
    // a bare year or numeric id sitting in prose
    for (const m of s.matchAll(/\b\d{4,}\b/g)) {
      if (!GENERIC_TOKENS.has(m[0])) add(m[0], `${why}, numeric identifier`, 'context', 2);
    }
  };

  /** Whole value, percent-decoded twin, date, UUID - what every identifying string gets. */
  const wholeAndEmbedded = (s, why) => {
    add(s, why);
    let decoded = s;
    try {
      decoded = decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      decoded = s;
    }
    if (decoded !== s) add(decoded, `${why}, percent-decoded`);
    const day = DAY_RE.exec(decoded);
    if (day) add(day[0], `${why}, recording date`, 'word');
    const uuid = UUID_RE.exec(decoded);
    if (uuid) add(uuid[0], `${why}, UUID`);
    return decoded;
  };

  const all = leaves(manifest);
  const unclassified = [];
  /** Leaves the schema knows by path but whose VALUE is not what it said it would be. */
  const invalid = [];
  const counts = { public: 0, identifier: 0, locator: 0, measurement: 0, prose: 0 };
  for (const [p, raw] of all) {
    const cls = classify(p);
    if (!cls) {
      unclassified.push(p);
      continue;
    }
    counts[cls.kind]++;
    const bad = validateLeaf(cls, p, raw, manifest);
    if (bad) invalid.push(`${p} ${bad}`);
    if (cls.kind === 'public' || cls.kind === 'measurement') continue;
    const why = `manifest ${p}`;

    if (cls.kind === 'prose') {
      if (typeof raw === 'string') proseNeedles(raw, why);
      else if (typeof raw === 'number') addNumber(raw, why);
      continue;
    }

    if (typeof raw === 'boolean') continue; // a flag has no text to leak; it is classified, which is the point
    if (typeof raw === 'number') {
      addNumber(raw, why);
      continue;
    }

    const decoded = wholeAndEmbedded(String(raw), why);
    if (cls.kind === 'locator') continue;
    // COARSE: split on separators only, so compound identifiers survive whole ("div-z", the
    // whole log filename, "ROUND_ROBIN_PHASE_...-vs-..."). Invented examples: the ones that stood
    // here were verbatim segments of the manifest's real archive path.
    for (const rawSeg of decoded.split(/[/\\\s"'?&=]+/)) {
      // trim the punctuation a separator split leaves behind: a URL scheme, a trailing comma.
      const seg = rawSeg.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!seg || GENERIC_TOKENS.has(seg.toLowerCase()) || ROBOT_NAME.test(seg)) continue;
      if (/^[\d.]+$/.test(seg)) continue;
      add(seg, `${why}, path segment`);
    }
    // FINE: split on everything, which is what catches a team name inside a filename.
    for (const t of decoded.split(/[^\p{L}\p{N}]+/u)) addToken(t, why);
  }
  return { needles, unclassified, invalid, counts, total: all.length };
}

/**
 * "final" is handled on its own, because the word is ordinary English and this repo uses it for
 * final arrays and final panel rects. Two rules:
 *
 *   F1  anywhere scanned, "final" within 80 characters of a competition-context word. That is the
 *       phrase that identifies a match, and it is the phrase the plan bans.
 *   F2  anywhere under demo/js/robots/ssl/, "final" at all. That module is the one that could
 *       identify the source, so it holds the stricter line and carries no "final" of its own.
 *
 * F1 TAKES THE SAME BY-HASH APPROVALS THE NEEDLES DO. F2 DOES NOT, ON PURPOSE. The asymmetry is
 * the point: F2 guards the module that could identify the source and its answer is always "move
 * the copy". F1 runs over the whole repository, which since --repo includes this gate and its
 * tests - and a rule about the word "final" cannot be WRITTEN DOWN without putting that word next
 * to "match". Refusing the approval there would not make the repo safer, it would make the rule
 * undocumentable. Every F1 approval is still an exact-text hash that dies the moment the sentence
 * is edited.
 *
 * MATCH_CTX is generic competition vocabulary. It names no event, no city, no team and no edition;
 * a reader learns from it only that this page is about a robot-soccer match, which the page says
 * on its own front.
 */
const MATCH_CTX =
  /\b(division|div\s+[ab]|match|game|tournament|championship|elimination|quarter|semi|playoff|bracket|cup|league|season|ssl|gamelog|game log)\b/i;
const SSL_MODULE = /^demo\/js\/robots\/ssl\//;

/**
 * EXACT APPROVED OCCURRENCES, by content hash.
 *
 * The previous version allowlisted by keyword: a line was forgiven for naming a team if it also
 * said "kicker". That forgives any future line that happens to mention a kicker, which is not an
 * approval, it is a pattern. These are approvals: file, plus the SHA-256 of the exact text around
 * the occurrence. Change the sentence and the hash stops matching, so the approval is re-earned
 * rather than inherited.
 *
 * Why any are approved at all: S19 requires every synthesized channel to CITE the published
 * firmware its names, units and ranges were taken from. Citing the reference implementation the
 * whole league cites says where the field names came from, not whose match this is - the opposite
 * of a leak. Running the gate prints the hash of any unapproved occurrence, so adding a legitimate
 * new citation is a copy-paste and a sentence of justification.
 */
const APPROVED_OCCURRENCES = [
  {
    file: 'demo/js/core/leadform.js',
    sha256: 'baa0cfeee9abfd84bf69213e4f86d8c49b6576ef234e0d75a3ffe88b4fb6c8d2',
    why: "the lead form's example placeholder names the open league a visitor might be building for",
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: '6bddeb7d9514c65288f7e74a4796bf39035e016792d8550e18ef2fcb91246135',
    why: 'the module header names the league this replay is from, which the page says on its own front',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: 'f13314a3c781171889cfcb147e3d83eed48b452300b1a6603923de5f1f67e8b4',
    why: 'S19: the header cites the published firmware every synthesized channel took its names from',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: '3d04295e8da076a84624ef78169e049d260e0114e876763197df3eb285faa6c4',
    why: 'S19: the OTA uplink citation, field for field',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: 'f83f3a6f7b39c17fb444754c8c69f17ee285248caaeb1dbe6406f6f1032951b8',
    why: 'S19: the base-station link-statistics citation',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: 'badf2bcfdacee20cd43f2afe2b3980ec5a96740e6bb1ae1ab48e775b75f3bba8',
    why: 'S19: the published dribbler ETDP, source of the 2-8 A band and the ~25,000 rpm',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: 'ff90c9e098a31bc1818b5ebed4c74c9003404c87583e5d7b7417f5beb2d01fea',
    why: 'S19: the published kicker and battery geometry the synthesis is dimensioned against',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: 'fc71aeb56401b58dc82efbcea4b72aeb4e80e65807786bb71ef1134bab984fe1',
    why: 'S19: the kicker channel note carries its own citation to the visitor and the analyst',
  },
  {
    file: 'demo/js/robots/ssl/data.js',
    sha256: '0f2ee1ee7db61ab15db92f724a4f3a78fc4bebdf17700ce4e7e9b8f4eea37caa',
    why: 'S19: the charge time constant cites the capacitor geometry it was derived from',
  },
  {
    file: 'demo/js/robots/ssl/patterns.js',
    sha256: '57f9fbac52b39b9041eb75e3ba4ccdef36e894c460c9bb6b9000e85733e06cf4',
    why: 'the pattern sheet is a published league standard and the art has to say whose',
  },
  {
    file: 'demo/js/robots/ssl/patterns.js',
    sha256: '0e590effced39761e0e87db625953d88395d0b9945f34f0e9a29a37f71873cde',
    why: 'the pattern sheet is a published league standard and the art has to say whose',
  },
  {
    file: 'demo/js/robots/ssl/patterns.js',
    sha256: '39bef2d00325a91a7a942bae888620aee85ae5b37fe208a81ca71b4325df45c1',
    why: 'the pattern sheet is a published league standard and the art has to say whose',
  },
  {
    file: 'demo/js/robots/ssl/scene.js',
    sha256: 'a41814021487f406940e9b990cacc46472958ae4f95894fc89e2c47b465d2d1f',
    why: 'the scene header names the league whose field and robot dimensions it builds to',
  },
  {
    file: 'worker/facts.generated.js',
    sha256: '189a5e5d30cc8ceda8ee83da1ab9674e1ba983a32bc80a48d0487ddbc29f3fc5',
    why: "the generated facts pack carries data.js's approved kicker citation through to the analyst",
  },
  // ---- reached only by --repo. Everything below is committed and never uploaded, which is why
  // the deployment-surface scan had never adjudicated a single one of them.
  {
    file: 'demo/DESIGN.md',
    sha256: '16564625d909423e70d6147ef225a4ae3a1f3c6f249e24154e0e89ea8c3fbc9e',
    why: 'S19, design side: the same published-firmware citation data.js carries, explained once',
  },
  {
    file: 'demo/DESIGN.md',
    sha256: 'c253df4155dbbd636f4487851e550076ec7550f1fd8007115f4ca83126a387af',
    why: 'names the league whose field and rules this replay is built to, which the page says on its own front',
  },
  {
    file: 'demo/GENSPEC.md',
    sha256: '1794c427bd7d355e7eb6ad77e7787251e330b70d1ca4c1aed3e120f4bfac8876',
    why: 'a display-name EXAMPLE for a generated demo, about no match at all',
  },
  {
    file: 'demo/GENSPEC.md',
    sha256: '8c9648623fb4801c0883cd5cabfda876db5dd71f28b193922edde95984232c1f',
    why: 'a generated-demo example that names a DIFFERENT competition, not this replay',
  },
  {
    file: 'demo/js/robots/gen-fixture/harness.mjs',
    sha256: 'cc83b898a72c7e7e5da03cf344d5db62e4e140994025c068014497a1ea7caafb',
    why: 'names the robot ARCHETYPE the generated-scene fixture builds, not a team and not a match',
  },
  {
    file: 'worker/demo-gen.test.md',
    sha256: '863a1fbcd992bc6f259a5b3920180e4a1da7ef7f3424af21de52ebfd8c668e45',
    why: "an example visitor prompt in the demo generator's own test doc, about their squad and not this one",
  },
  // The generator runner's cost-calibration notes, about the FIRST demo it ever generated for a
  // visitor: their own 2v2 squad, described in their own words in the prompt above. Same subject as
  // the demo-gen.test.md line, one file over, and nothing in either sentence is about this replay.
  {
    file: 'worker/runner-patches/runner.mjs',
    sha256: 'b96a98653290ac427e9b54f004d8330cd03ac9b148ba5a9e9e8fc3ba3a4bb26c',
    why: "a token-budget note naming the visitor's own squad from the first generation job, not this match",
  },
  {
    file: 'worker/runner-patches/runner.mjs',
    sha256: '39b9990bec99645138a89379b2e6545117279c5bba4f7752a2c27ccc8060c663',
    why: 'the same job, one line on: how long that visitor-described fleet took to generate',
  },
  // ---- F1 on the gate and its tests. A rule about a word cannot be written down without using
  // the word; see the asymmetry note above MATCH_CTX. F2 still has no hatch, and none of these
  // four files is under the SSL module.
  {
    file: 'demo/js/robots/gen-fixture/ssl-leak-check.mjs',
    sha256: '38f5f8470a2281e64a8996f4600f1dc6991f6a46ecf7e8f6b4b8b30be01ae7a7',
    why: "MATCH_CTX's own vocabulary list: a lowercase alternation of ordinary competition English",
  },
  {
    file: 'demo/js/robots/gen-fixture/ssl-leak-check.mjs',
    sha256: '0ff57b15807addbe0ec407a1746145ee0a4e2dd08c7636e77d3daff23d0a7af4',
    why: 'the header naming the one word the proximity rules reserve',
  },
  {
    file: 'demo/js/robots/gen-fixture/ssl-leak-check.mjs',
    sha256: '10ad44e09c795164364f5e201be7883113b3353fce11d82ddf0f16d032def6b2',
    why: 'the F2 rule, stated',
  },
  {
    file: 'demo/js/robots/gen-fixture/ssl-leak-check.mjs',
    sha256: '61245d7946e477cd890afb02484fcf17b9e924e2a370c1475104adaed342caf8',
    why: "the F2 report's own message string",
  },
  {
    file: 'demo/js/robots/gen-fixture/ssl-leak-check.mjs',
    sha256: '38911605ec098b36879b3621be9f95fa793b9585b8b7e639f0abf9eeecb87b30',
    why: "the F1 report's own message string",
  },
  {
    file: 'demo/DESIGN.md',
    sha256: '6a02f27418b37786ee90837b56a3c92686d9e27aadce29fcec78480e365b39a1',
    why: 'DESIGN.md stating the ban, which is the sentence that makes the ban auditable',
  },
  {
    file: 'demo/js/robots/gen-fixture/ssl-preview-fallback.test.mjs',
    sha256: '875131dcf5b2d1681fd2ce38ba20e4c6508285cfcbd50bab7b49cb649b63889a',
    why: 'the assertion label of the test that PROVES the brief never says it',
  },
  // Donna is a different, publicly attributed source. These exact occurrences name Donna's source,
  // event or rules context and disclose no identifier from the de-identified SSL match.
  {
    file: 'demo/js/robots/donna/data.js',
    sha256: 'f11c1691e2b05dc554c275dc3e6727d4abee7d4b8136cf2a2dd81fb587b2b28a',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/donna-data.js',
    sha256: 'c56394b4205c1b675221664a420b9e9ee8ecb98cfc0695178291acfd17639487',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/preview-data.js',
    sha256: '8f20ef6348d07769253a1e108b743146d79692fbbf98a676921b84c719253de1',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/scene.js',
    sha256: '7bfe13e1a40b747f908872a015ccec59da1333976bca30d46718573224ee453a',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/scene.js',
    sha256: '543f991b958c887c950377549d835e36660eb3c230db8321f7436a28504c749e',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/scene.js',
    sha256: '7123963aa50f0f82f5bf6d67261dab21291f9b317bb2acfb42468671b9cef226',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/scene.js',
    sha256: '138edcad477f0cc531d07e199cf95a752546c8c91ae1d7c6a2088fb593a4e784',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/scene.js',
    sha256: 'd6a9548c75fd63961c82ef95ab199d4a35e4b1065e2de24374bb28d478d305c0',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: 'f30752bcbe5c13e52d71baf8b1eb73fdff20b6932a3abf575d38579001328561',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: '3ebc0158ffe0c6fe77a9c3fd1b12857453ca420d9dd28d73368d4d0b8f685b00',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: 'b15ef81f4f5360593dab0a940e69dc0265a63ce6661089b140004944776147d9',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: '995c1d3251150da8740556e74521fb5a478e0149dfe561816979dac4b78e5fa1',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: 'ca88437bcb1d8e370cefc2cc39262c3249f9f83776f702e49852ea36efee81ed',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: 'fea824aa45c21b933946363b75dc44088aa6ff0401786da917cf5ccd736f6a3f',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/donna/script.js',
    sha256: '46fb9c4e2d0961292e9c4f99e419069514ccdb58c469e9024a68c27f188f9b1e',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'worker/facts.generated.js',
    sha256: '9c63afb474cda575131b2c13b276c27c3908515fdcf50c240c9ad4551f0836df',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'worker/facts.generated.js',
    sha256: '1bfb2b125c6f23a96b8b91e0b2763a4ca7ead7b1eb0fe5a79408132a4f1d4e29',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'worker/facts.generated.js',
    sha256: 'c273b8adc9ce68b8a98ea75e83335e6aa0570b79b717265bc7f4482a17397acb',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'worker/facts.generated.js',
    sha256: '43797df8516696e4c1c9ca90377113cd856cd21eca30964574a0c79412ed7da6',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'worker/facts.generated.js',
    sha256: 'df5fdeb833a56c6509e8e664ffd06224aa035a8f3c991d6650b5aed045d0da15',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/DESIGN.md',
    sha256: '6c29fc46f1f10f514acf799b5ea52698302031979acc7bd67124f2727fdf7c71',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/DESIGN.md',
    sha256: '0642958943db8bbbf9fb9071525d079c988fe3e8aab8737d624ca737bb76ffa3',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/gen-fixture/donna-hud.test.mjs',
    sha256: '8659588e95717e69c4e751b715b53211935ee7accab55109f2b3b262f9bc60f0',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/gen-fixture/donna-script.test.mjs',
    sha256: '45028eae2e48358e22875a5bf33deaa73d5bc823c6ee7d0f8b4956264aec8a74',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/gen-fixture/donna-script.test.mjs',
    sha256: 'd34a3756b85e675260330c220fea64994838aa4a43cb273835dc8b3376a3ca12',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/gen-fixture/donna-script.test.mjs',
    sha256: 'e4c614226a4f597710c26533b6a7f1efaba5594b3c0ddeca8be0682684a837b4',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
  {
    file: 'demo/js/robots/gen-fixture/donna-script.test.mjs',
    sha256: '0a4c0b21c9b258c4ada6c18e98aef075a1506e69f9e39afceff34e25dadb4c6f',
    why: "donna mission's Hugh-approved factual attribution; names donna's source, not the SSL match",
  },
];

/** The exact text an approval covers: the line, or a window around the hit on a megaline file. */
function unitOf(rel, line, index, termLength) {
  if (MEGALINE.some((re) => re.test(rel))) {
    return line.slice(Math.max(0, index - 80), index + termLength + 80);
  }
  return line;
}

const approvalIndex = new Map();
for (const a of APPROVED_OCCURRENCES) approvalIndex.set(`${a.file} ${a.sha256}`, a);
const approved = (rel, unit) => approvalIndex.has(`${rel} ${sha(unit)}`);

/**
 * Generated data modules are one enormous base64 literal. It is machine-emitted bytes, not copy,
 * and a five-letter word turning up inside 490 KB of base64 is noise. Blank the literal for the
 * word-boundary rules; the exact manifest strings are still checked against the whole file, and
 * `verify_export.mjs` checks them there too.
 */
const blankBlob = (txt) =>
  txt.replace(/(BLOB_B64\s*=\s*")([^"]*)(")/g, (_m, a, b, c) => a + ' '.repeat(b.length) + c);

// ---------------------------------------------------------------- the scan

/** Word-boundary matcher. NOT \b - see the comment in scanText. */
const wordRe = (term) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

/**
 * Scan one unit of published text against the needles, plus the two "final" proximity rules.
 *
 * `rel` and `label` are separate on purpose. One FILE contributes up to three units - its UTF-8
 * text, its raw bytes when it carries a NUL, and its own path, because a file called
 * `<team>-hero.png` publishes the team name in the URL bar of anyone who opens it and reading its
 * bytes will never say so. `label` says which unit a hit came from; `rel` is the file, and it is
 * what the approval, the megaline rule and F2 all key on. Keying approvals on the label instead
 * would demand a separate approval per unit for one sentence, which is bookkeeping, not a decision.
 *
 * @param {string} rel   the file, for the approval key, MEGALINE and F2
 * @param {string} label what the message says the text was
 * @param {string} raw   the text to scan
 * @param {Array} needles
 * @param {(msg:string)=>void} report
 * @returns {number} candidate occurrences adjudicated
 */
function scanText(rel, label, raw, needles, report) {
  let checked = 0;
  const scrubbed = blankBlob(raw);
  const lines = raw.split('\n');
  const scrubbedLines = scrubbed.split('\n');

  for (const n of needles) {
    const bounded = n.kind !== 'exact';
    const hay = bounded ? scrubbed : raw;
    if (!fold(hay).includes(n.folded)) continue;
    // NOT \b: JavaScript's word boundary counts `_` as a word character, so `\bROUND_ROBIN\b`
    // does not match inside `ROUND_ROBIN_PHASE` - which is exactly the shape an archive label
    // arrives in. The boundary here is "not a letter and not a digit", so an underscore, a hyphen
    // and a dot all end a token. Invented label, for the same reason as everywhere else here.
    const re = bounded ? wordRe(n.term) : null;
    const src = bounded ? scrubbedLines : lines;
    for (let i = 0; i < src.length; i++) {
      let from = 0;
      for (;;) {
        let at = -1;
        if (re) {
          const m = re.exec(src[i].slice(from));
          if (m) at = from + m.index;
        } else {
          at = fold(src[i]).indexOf(n.folded, from);
        }
        if (at < 0) break;
        from = at + Math.max(1, n.term.length);
        // A context needle is only a leak beside a competition word. On its own "div" or "1854" is
        // noise; next to "match" it is half an archive label.
        if (n.kind === 'context') {
          const near = src[i].slice(Math.max(0, at - 80), at + n.term.length + 80);
          if (!MATCH_CTX.test(near)) {
            if (from >= src[i].length) break;
            continue;
          }
        }
        checked++;
        const unit = unitOf(rel, lines[i], at, n.term.length);
        if (!approved(rel, unit)) {
          report(
            `${label}:${i + 1}  "${n.term}"  (${n.why}${n.kind === 'context' ? ', beside a competition word' : ''})\n` +
              `        ${unit.trim().slice(0, 140)}\n` +
              `        if this is a legitimate citation, approve THIS occurrence: sha256 ${sha(unit)}`,
          );
        }
        if (from >= src[i].length) break;
      }
    }
  }

  // F1 / F2: "final"
  for (let i = 0; i < scrubbedLines.length; i++) {
    const L = scrubbedLines[i];
    const fm = /\bfinals?\b/i.exec(L);
    if (!fm) continue;
    checked++;
    const near = L.slice(Math.max(0, fm.index - 80), fm.index + fm[0].length + 80);
    if (SSL_MODULE.test(rel)) {
      // F2 has no approval hatch and never gets one. See the block above MATCH_CTX.
      report(
        `${label}:${i + 1}  "final" inside the SSL module (F2: that module carries none)\n        ${lines[i].trim().slice(0, 140)}`,
      );
    } else if (MATCH_CTX.test(near)) {
      const unit = unitOf(rel, lines[i], fm.index, fm[0].length);
      if (!approved(rel, unit)) {
        report(
          `${label}:${i + 1}  "final" beside a competition word (F1: reads as a match identifier)\n` +
            `        ${unit.trim().slice(0, 140)}\n` +
            `        if this sentence has to say the word, approve THIS occurrence: sha256 ${sha(unit)}`,
        );
      }
    }
  }
  return checked;
}

/**
 * One published file: its content AND its path. The path is scanned as its own unit so the message
 * says which of the two leaked - a file whose NAME identifies the match is a leak even if every
 * byte inside it is clean, and it is the one an ordinary content scan can never see.
 *
 * `raw` may be a Buffer or a string. A Buffer goes through unitsOf(), which is where the raw-byte
 * pass for a NUL-carrying file comes from.
 */
function scanServed(rel, raw, needles, report) {
  const units = Buffer.isBuffer(raw) ? unitsOf(rel, raw) : [{ label: rel, text: raw }];
  let checked = 0;
  for (const u of units) checked += scanText(rel, u.label, u.text, needles, (m) => report(m));
  checked += scanText(rel, `${rel} (served path)`, rel, needles, (m) => report(m));
  return checked;
}

/**
 * A whole surface: read each file's bytes and adjudicate them. One function so the self-test's
 * synthetic repositories go through exactly the code the acceptance run does, rather than through
 * a re-implementation of it that could agree with a bug.
 */
function scanAll(root, files, needles, report) {
  let checked = 0;
  for (const rel of files) checked += scanServed(rel, readBytes(root, rel), needles, report);
  return checked;
}

// ---------------------------------------------------------------- adversarial self-test
//
// One fixture per class the previous gate did not scan, each of them a thing that would have
// passed: an identifying manifest COMMENT, a SHORT string, a NUMERIC id, a new BOOLEAN leaf, and an
// identifying served FILENAME. Then one per SUBTREE the gate after that certified wholesale - the
// five wildcard regexes - each planting a leaf nobody has read exactly where the wildcard would
// have stamped it public. And one for the value validators, because a leaf can be known by path
// and still be carrying the wrong thing.
//
// Every fixture must be caught, and the paired cases prove the opposite half - that a short token
// on its own, a clean file, and the leaves that really are enumerated inside those subtrees are not
// failures - because a gate that fires on everything is not a gate either.
//
// Every identifier below is INVENTED. This file names no real match, no real team and no real
// archive, which is the property the whole thing exists to protect, and a fixture is not an
// exception to it. The invented names carry the SHAPES real ones do (a capital run into lowercase,
// a capital-lowercase-capital) because those shapes are what the prose rule keys on.

if (SELF_TEST) {
  let bad = 0;
  const t = (name, ok, detail = '') => {
    if (ok) console.log(`  PASS  ${name}`);
    else {
      bad++;
      console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
    }
  };
  /** Failures from scanning one synthetic served unit against needles from one synthetic manifest. */
  const run = (manifest, rel, content) => {
    const out = [];
    const built = buildNeedles(manifest);
    scanServed(rel, content, built.needles, (m) => out.push(m));
    return { hits: out, built };
  };

  console.log('SELF-TEST  adversarial fixtures for the classes this gate used to skip\n');

  // 1. an identifying manifest COMMENT. Comments were exempt outright.
  {
    const m = { exporter: { config: { _comment: ['window picked around the KrellTech equaliser'] } } };
    const leak = run(m, 'demo/js/robots/ssl/data.js', '// the window sits over the KrellTech push');
    t('comment-field leak is caught', leak.hits.length > 0, leak.hits[0] || 'no hit');
    const clean = run(m, 'demo/js/core/chart.js', '// the window sits over the busiest stretch');
    t('and ordinary prose is not', clean.hits.length === 0, clean.hits[0] || '');
  }

  // 2. a SHORT string. Anything under four characters was dropped.
  {
    const m = { source: { match: { teams: { yellow: 'KT' } } } };
    const leak = run(m, 'demo/js/robots/ssl/script.js', "const label = 'KT match replay';");
    t('short identifier beside a competition word is caught', leak.hits.length > 0, leak.hits[0] || 'no hit');
    const noise = run(m, 'demo/js/core/chart.js', 'const KT = 3; // kerning table');
    t('and the same three letters in ordinary code are not', noise.hits.length === 0, noise.hits[0] || '');
  }

  // 3. NUMERIC identifiers. Numbers outside one hard-coded path list were ignored.
  {
    const loc = { source: { window: { tStartS: 4711.5 } } };
    const leak = run(loc, 'demo/js/robots/ssl/data.js', '// the match window opens at 4711 s in the source log');
    t('a window locator beside a competition word is caught', leak.hits.length > 0, leak.hits[0] || 'no hit');

    const id = { source: { match: { recorded: 20310102 } } };
    const leakId = run(id, 'demo/js/core/context.js', 'const recordingId = 20310102;');
    t('a long numeric id is caught with no context needed', leakId.hits.length > 0, leakId.hits[0] || 'no hit');
  }

  // 4. a BOOLEAN. Booleans were skipped entirely, so a new one was never even classified.
  {
    const built = buildNeedles({ source: { substitutionsWereReviewed: true } });
    t(
      'a new boolean leaf is UNCLASSIFIED, not silently skipped',
      built.unclassified.includes('source.substitutionsWereReviewed'),
      `unclassified: ${built.unclassified.join(', ') || 'none'}`,
    );
    const known = buildNeedles({ exporter: { gitDirty: false } });
    t(
      'a boolean that IS classified passes',
      known.unclassified.length === 0,
      `unclassified: ${known.unclassified.join(', ')}`,
    );
    const newPath = buildNeedles({ source: { venue: { city: 'Someplace' } } });
    t(
      'and so does any other new leaf, whatever its type',
      newPath.unclassified.includes('source.venue.city'),
      `unclassified: ${newPath.unclassified.join(', ') || 'none'}`,
    );
  }

  // 5. an identifying served FILENAME. Contents were scanned; the name they are served under was not.
  {
    const m = { source: { realTeamNames: { blue: 'NovaBots' } } };
    const leak = run(m, 'demo/assets/novabots-hero.png', 'nothing identifying in the bytes at all');
    t('an identifying served filename is caught', leak.hits.length > 0, leak.hits[0] || 'no hit');
    t(
      'and the message says it was the path, not the contents',
      leak.hits.some((h) => h.includes('(served path)')),
      leak.hits[0] || 'no hit',
    );
    const clean = run(m, 'demo/assets/robot-hero.png', 'nothing identifying in the bytes at all');
    t('a clean file with a clean name is not', clean.hits.length === 0, clean.hits[0] || '');
  }

  // 6. an unknown leaf INSIDE each formerly WILDCARDED subtree. Five regexes used to classify
  //    every descendant of these as public, so a field nobody had ever read arrived pre-cleared -
  //    and the old self-test only ever planted new leaves OUTSIDE them, which is why it agreed.
  {
    const cases = [
      ['emitted', { emitted: { sourceLog: 'KrellTech-vs-NovaBots.log.gz' } }, 'emitted.sourceLog'],
      [
        'source.renameMap',
        { source: { renameMap: { originalYellow: 'KrellTech' } } },
        'source.renameMap.originalYellow',
      ],
      [
        'exporter.config.teams',
        { exporter: { config: { teams: { blue: { originalName: 'NovaBots' } } } } },
        'exporter.config.teams.blue.originalName',
      ],
      [
        'exporter.config.vision',
        { exporter: { config: { vision: { cameraVenue: 'Someplace Arena' } } } },
        'exporter.config.vision.cameraVenue',
      ],
      ['gates', { gates: { measured: { sourceMatchLabel: 'KrellTech 0 - 5 NovaBots' } } }, 'gates.measured.sourceMatchLabel'],
    ];
    for (const [subtree, m, leaf] of cases) {
      const built = buildNeedles(m);
      t(
        `an unknown leaf inside \`${subtree}\` is UNCLASSIFIED, not stamped public by a wildcard`,
        built.unclassified.includes(leaf),
        `unclassified: ${built.unclassified.join(', ') || 'none'}`,
      );
    }
    // ... and the leaves that ARE enumerated inside those same five subtrees still pass, so the
    // schema is a list of what has been read and not a blanket refusal.
    const known = buildNeedles({
      emitted: { matchDataRawBytes: 699054, cameraFocus: { grid: 'robot' } },
      source: { renameMap: { yellow: 'Polaris Robotics' } },
      exporter: { config: { teams: { blue: { accent: '#6E7F8D' } }, vision: { binSeconds: 0.25 } } },
      gates: { pass: true, limits: { decodeMaxMs: 50 } },
    });
    t(
      'while the enumerated leaves in those subtrees classify as before',
      known.unclassified.length === 0,
      `unclassified: ${known.unclassified.join(', ')}`,
    );
  }

  // 7. a leaf that IS in the schema but whose VALUE contradicts it. The rename map is the sharp
  //    end: it is the whole de-identification written as two strings, and a gate that scans text
  //    for the real name would never notice the map itself starting to carry it.
  {
    const good = {
      source: { realTeamNames: { yellow: 'KrellTech' }, renameMap: { yellow: 'Polaris Robotics' } },
      exporter: { config: { teams: { yellow: { displayName: 'Polaris Robotics', accent: '#C08457' } } } },
    };
    t(
      'a rename map carrying the fictional name is valid',
      buildNeedles(good).invalid.length === 0,
      buildNeedles(good).invalid.join('; '),
    );

    const leaked = JSON.parse(JSON.stringify(good));
    leaked.source.renameMap.yellow = 'KrellTech';
    const leakedOut = buildNeedles(leaked).invalid;
    t(
      'a rename map that has started carrying the REAL name is invalid',
      leakedOut.some((m) => /source\.renameMap\.yellow/.test(m)),
      leakedOut.join('; ') || 'nothing flagged',
    );

    const drifted = JSON.parse(JSON.stringify(good));
    drifted.source.renameMap.yellow = 'Polaris Robotic';
    t(
      'and so is one that has drifted off the name the config publishes',
      buildNeedles(drifted).invalid.some((m) => /renameMap/.test(m)),
      buildNeedles(drifted).invalid.join('; ') || 'nothing flagged',
    );

    const badColour = JSON.parse(JSON.stringify(good));
    badColour.exporter.config.teams.yellow.accent = 'RobotOrange';
    t(
      'a hull/accent colour that is not a hex triplet is invalid',
      buildNeedles(badColour).invalid.some((m) => /accent/.test(m)),
      buildNeedles(badColour).invalid.join('; ') || 'nothing flagged',
    );

    const badType = buildNeedles({ gates: { limits: { decodeMaxMs: '50 ms' } } });
    t(
      'a numeric gate that has become a string is invalid',
      badType.invalid.some((m) => /decodeMaxMs.*string/.test(m)),
      badType.invalid.join('; ') || 'nothing flagged',
    );
  }

  // 8. THE TWO SURFACES, and the two holes the version before this one had. Both fixtures are
  //    whole synthetic REPOSITORIES on disk, scanned through `surfaceFiles`, `repoFiles` and
  //    `scanAll` - the same three functions the acceptance run uses - because the defect being
  //    pinned is in the file COLLECTION and the file READING, and a fixture that hand-fed a string
  //    to `scanServed` would have agreed with the broken version.
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssl-leak-selftest-'));
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    // The same shape this repo has: a directory that is committed and deliberately never uploaded.
    writeFileSync(path.join(dir, '.assetsignore'), 'gate/\n');
    writeFileSync(path.join(dir, 'index.html'), '<p>a professional match, 2026 season</p>');
    mkdirSync(path.join(dir, 'gate'));
    // (a) a leak in a file `.assetsignore` excludes and git tracks. This is the CRITICAL finding
    //     itself, as a fixture: a de-identification checker that names a team, inside the one
    //     directory the deployment-surface scan is structurally unable to look at.
    writeFileSync(
      path.join(dir, 'gate', 'checker.mjs'),
      '// examples: KrellTech and NovaBots are the two shapes a real name has\n',
    );
    // (b) a leak inside a NUL-carrying file. An ASCII identifier between two NUL bytes, which is
    //     what an identifier in a PNG text chunk or an icon header looks like.
    writeFileSync(
      path.join(dir, 'hero.png'),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
        Buffer.from('tEXtComment\0KrellTech vs NovaBots', 'latin1'),
        Buffer.from([0x00, 0x01, 0x02]),
      ]),
    );
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });

    const m = {
      source: { realTeamNames: { yellow: 'KrellTech', blue: 'NovaBots' } },
    };
    const built = buildNeedles(m);
    const surface = surfaceFiles(dir);
    const tracked = repoFiles(dir);

    t(
      'the deployment-surface scan cannot see an assetsignored file',
      !surface.includes('gate/checker.mjs'),
      `surface: ${surface.join(', ')}`,
    );
    t(
      '--repo mode does: git tracks it, so the world can read it',
      tracked.includes('gate/checker.mjs'),
      `tracked: ${tracked.join(', ')}`,
    );

    const surfaceHits = [];
    scanAll(dir, surface, built.needles, (msg) => surfaceHits.push(msg));
    t(
      'and the surface scan reports NOTHING there, which is why it was not enough',
      !surfaceHits.some((h) => h.includes('gate/checker.mjs')),
      surfaceHits.join(' | '),
    );

    const repoHits = [];
    scanAll(dir, tracked, built.needles, (msg) => repoHits.push(msg));
    t(
      'a leak planted in an assetsignored-but-tracked file IS caught in --repo mode',
      repoHits.some((h) => h.startsWith('gate/checker.mjs')),
      repoHits.join(' | ') || 'no hit',
    );
    t(
      'a leak inside a NUL-carrying file is caught, as raw bytes',
      repoHits.some((h) => h.includes('hero.png (raw bytes)')),
      repoHits.filter((h) => h.includes('hero.png')).join(' | ') || 'no hit',
    );
    // The opposite half: the clean page in the same repository is not a failure, so this is a gate
    // and not a refusal to scan anything at all.
    t(
      'and the clean served page in the same repository is not',
      !repoHits.some((h) => h.startsWith('index.html')),
      repoHits.join(' | '),
    );
  }

  console.log(`\nSELF-TEST  ${bad === 0 ? 'all fixtures caught' : `${bad} FAILED`}`);
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- run

const manifestPresent = existsSync(MANIFEST);

if (!manifestPresent && !DEV_PARTIAL) {
  console.error(
    'FAIL  the de-identification gate cannot run.\n' +
      `      The private match manifest is not on this machine (looked at ${MANIFEST}).\n` +
      '      Every match-identifying string this gate looks for is derived from that file, so\n' +
      '      without it there is no forbidden list and a pass would mean nothing.\n' +
      '      Point --manifest or $SSL_MATCH_MANIFEST at it, or run --dev-partial for the\n' +
      '      generic rules alone (which is NOT the acceptance gate and never releases anything).',
  );
  process.exit(1);
}

let manifest = null;
let needles = [];
if (manifestPresent && !DEV_PARTIAL) {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const missing = REQUIRED_MANIFEST_PATHS.filter((p) => !hasPath(manifest, p));
  if (missing.length) {
    console.error(
      'FAIL  the private manifest is missing paths this gate derives its forbidden list from:\n' +
        missing.map((p) => `        ${p}`).join('\n') +
        '\n      A renamed or dropped identifier must fail the gate, not shrink it silently.',
    );
    process.exit(1);
  }
  const built = buildNeedles(manifest);
  // FAIL CLOSED ON AN UNCLASSIFIED LEAF. A field nobody has said anything about is not a field
  // this gate has cleared: it is a field this gate did not look at. That is how a boolean, a
  // three-character code, a numeric id and every comment in the file went unscanned for months
  // under a policy that called itself default-forbid.
  if (built.unclassified.length) {
    console.error(
      'FAIL  the private manifest carries leaves this gate has no classification for:\n' +
        built.unclassified.map((p) => `        unclassified manifest leaf: ${p}`).join('\n') +
        '\n      Add each to MANIFEST_SCHEMA by its exact path, as public-by-design or as one of\n' +
        '      the forbidden kinds, with its type and the reason. There is no default bucket and\n' +
        '      no subtree wildcard: an unclassified leaf is an unscanned leaf, and an unscanned\n' +
        '      leaf cannot be certified.',
    );
    process.exit(1);
  }
  // A leaf whose VALUE is not what the schema said it would be is a leaf whose classification was
  // written about something else. The rename map is the sharp end of this: if it ever stops
  // carrying the fictional names, the de-identification is over and everything downstream of it is
  // wrong, and no amount of string scanning would notice.
  if (built.invalid.length) {
    console.error(
      'FAIL  the private manifest carries leaves whose values contradict the schema:\n' +
        built.invalid.map((m) => `        ${m}`).join('\n') +
        '\n      Fix the manifest, or - if the field legitimately changed shape - re-read it and\n' +
        '      update its MANIFEST_SCHEMA entry, which is the point at which someone looks.',
    );
    process.exit(1);
  }
  needles = built.needles;
  console.log(`private manifest: ${MANIFEST}`);
  const c = built.counts;
  console.log(
    `${built.total} manifest leaves, all classified ` +
      `(${c.public} public, ${c.identifier} identifier, ${c.locator} locator, ` +
      `${c.measurement} measurement, ${c.prose} prose) -> ${needles.length} derived forbidden strings`,
  );
} else {
  console.warn(
    'DEV-PARTIAL  no manifest-derived rules. This run cannot certify anything for release.',
  );
}

const files = REPO_MODE ? repoFiles() : surfaceFiles();
if (REPO_MODE) {
  const surface = new Set(surfaceFiles());
  const beyond = files.filter((rel) => !surface.has(rel)).length;
  console.log(
    `REPO MODE  scanning ${files.length} tracked files ` +
      `(${beyond} of them outside the deployment surface: this directory, the design docs, the worker)\n`,
  );
} else {
  const extras = EXTRA_SCAN.filter(([rel]) => files.includes(rel));
  console.log(
    `scanning ${files.length} files (${extras.length} of them not uploaded but still served through the worker)\n`,
  );
}

checks += scanAll(ROOT, files, needles, fail);

console.log(
  `\n${files.length} files scanned (content, raw bytes where the file has any, and path), ` +
    `${checks} candidate occurrences adjudicated, ` +
    `${failures} leak${failures === 1 ? '' : 's'}`,
);
if (DEV_PARTIAL) {
  console.log('DEV-PARTIAL: generic rules only. This is not the release gate.');
}
process.exit(failures ? 1 : 0);
