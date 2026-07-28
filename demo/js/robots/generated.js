// robots/generated.js - the loader for generated personalized demos.
//
// A generated robot is not a directory of code. It is ONE JSON document (GENSPEC v1) fetched at
// route time from `/demo/js/robots/g-<slug>/def.json` and turned into the exact same
// RobotDefinition shape the four canned robots default-export, so viewer.js, chart.js, chat.js
// and context.js never learn that this robot arrived over the wire.
//
//   loadGeneratedRobot('g-abcdefghijklmnopqrst') -> RobotDefinition | null
//
// Trust model. The worker validates the def before it ever serves it, and the interpreters in
// core/genscene.js and core/gendata.js degrade rather than throw on junk. The gate below is the
// third layer: a cheap client-side shape check whose only job is to make a broken or truncated
// bundle render the "not available" card instead of a half-built demo. It never repairs a def,
// it only accepts or rejects it, and every rejection names its own reason once.

import { buildDataFromSpec } from '../core/gendata.js';
import { buildSceneFromSpec } from '../core/genscene.js';

/** Slug shape the worker mints: crockford-ish base32, 20 chars. */
export const GEN_ID_RE = /^g-[a-z2-7]{20}$/;

/** GENSPEC section 1: every display string is printable ASCII plus newline. */
const ASCII = /^[\x20-\x7E\n]*$/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const CHANNEL_RE = /^\/[a-z][a-z0-9_]{0,15}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;
const FINDING_RE = /^[a-z0-9-]{2,24}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && ASCII.test(v);
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * Structural gate over a parsed def.json. Returns null when the def is usable, otherwise a short
 * reason string naming the offending path, which is what gets logged.
 *
 * @param {any} def
 * @returns {string|null}
 */
function gateReason(def) {
  if (!isObj(def)) return 'def is not an object';
  if (def.spec_version !== 1) return `spec_version ${JSON.stringify(def.spec_version)} is not 1`;

  // ---- identity + display strings
  if (!isStr(def.robot_name, 48)) return 'robot_name missing or not printable ASCII';
  if (!isStr(def.device_line, 72)) return 'device_line missing or not printable ASCII';
  if (!isStr(def.device_id, 24) || !/^[a-z0-9][a-z0-9-]{1,22}$/.test(def.device_id)) return 'device_id is not a slug';
  if (!isStr(def.tagline, 80)) return 'tagline missing or not printable ASCII';
  if (typeof def.accent !== 'string' || !ACCENT_RE.test(def.accent)) return `accent ${JSON.stringify(def.accent)} is not #rrggbb`;

  // ---- determinism + timebase. The seed is the def's own, never seedFor(id): the runner
  // computed the facts pack the analyst answers from with THIS integer.
  if (!Number.isInteger(def.seed) || def.seed < 1 || def.seed > 2147483647) return 'seed is not an int in 1..2147483647';
  if (!isNum(def.duration, 15, 180)) return `duration ${def.duration} is outside 15..180 s`;
  if (!isNum(def.rate, 10, 100)) return `rate ${def.rate} is outside 10..100 Hz`;

  // ---- channels
  if (!Array.isArray(def.channels) || def.channels.length < 1 || def.channels.length > 6) return 'channels is not an array of 1..6';
  const fieldPaths = [];
  for (const c of def.channels) {
    if (!isObj(c) || typeof c.path !== 'string' || !CHANNEL_RE.test(c.path)) return `channel path ${JSON.stringify(c && c.path)} is malformed`;
    if (!Array.isArray(c.fields) || c.fields.length < 1 || c.fields.length > 6) return `channel ${c.path} has no fields`;
    for (const f of c.fields) {
      if (!isObj(f) || typeof f.key !== 'string' || !KEY_RE.test(f.key)) return `field key ${JSON.stringify(f && f.key)} on ${c.path} is malformed`;
      if (!isStr(f.label, 32)) return `field ${c.path}.${f.key} has no printable label`;
      if (typeof f.unit !== 'string' || f.unit.length > 16 || !ASCII.test(f.unit)) return `field ${c.path}.${f.key} unit is malformed`;
      fieldPaths.push(`${c.path}.${f.key}`);
    }
  }

  // ---- data_spec: an entry per declared field, or gendata builds a channel with holes in it
  if (!isObj(def.data_spec)) return 'data_spec is missing';
  for (const p of fieldPaths) {
    if (!isObj(def.data_spec[p])) return `data_spec has no entry for ${p}`;
  }

  // ---- scene_spec
  if (!isObj(def.scene_spec)) return 'scene_spec is missing';
  if (!Array.isArray(def.scene_spec.units) || def.scene_spec.units.length < 1) return 'scene_spec.units is empty';

  // ---- findings
  if (!Array.isArray(def.findings) || def.findings.length < 1) return 'findings is empty';
  const findingIds = new Set();
  for (const f of def.findings) {
    if (!isObj(f) || typeof f.id !== 'string' || !FINDING_RE.test(f.id)) return `finding id ${JSON.stringify(f && f.id)} is malformed`;
    if (findingIds.has(f.id)) return `finding id ${f.id} is duplicated`;
    findingIds.add(f.id);
    if (!isStr(f.title, 120)) return `finding ${f.id} has no printable title`;
    // `duration + 1e-9`, the same epsilon the runner's validate.mjs and the worker re-check use.
    // A window that ends exactly at duration is legal, and floating point makes "exactly" a
    // range: without the epsilon a def could pass both server gates and be rejected here.
    if (!Array.isArray(f.window) || f.window.length !== 2 || !f.window.every((n) => isNum(n, 0, def.duration + 1e-9))) {
      return `finding ${f.id} window is not two times inside the mission`;
    }
    if (f.window[1] <= f.window[0]) return `finding ${f.id} window ends before it starts`;
    if (!isObj(f.focus) || typeof f.focus.channel !== 'string' || !Array.isArray(f.focus.fields)) return `finding ${f.id} focus is malformed`;
  }

  // ---- chat
  if (!isObj(def.chat)) return 'chat block is missing';
  if (!isStr(def.chat.first_question, 120)) return 'chat.first_question is missing or not printable ASCII';
  if (!Array.isArray(def.chat.suggested) || def.chat.suggested.length < 1) return 'chat.suggested is empty';
  for (const s of def.chat.suggested) {
    if (!isStr(s, 72)) return 'a chat.suggested entry is not printable ASCII';
  }
  if (!Array.isArray(def.chat.script) || def.chat.script.length < 1) return 'chat.script is empty';
  for (const e of def.chat.script) {
    if (!isObj(e) || typeof e.id !== 'string') return 'a chat.script entry has no id';
    if (!Array.isArray(e.matchers) || !e.matchers.length) return `chat.script ${e.id} has no matchers`;
    if (!isStr(e.answer, 3000)) return `chat.script ${e.id} answer is missing or not printable ASCII`;
    // An unresolvable evidence id is a chip that fires nothing, which reads as a broken demo
    // rather than a missing one, so it fails the whole bundle here.
    const ev = e.evidence == null ? [] : e.evidence;
    if (!Array.isArray(ev)) return `chat.script ${e.id} evidence is not an array`;
    for (const id of ev) {
      if (!findingIds.has(id)) return `chat.script ${e.id} cites unknown finding "${id}"`;
    }
  }

  return null;
}

/**
 * The def.json URL for a slug, resolved off THIS module's own location rather than the page's,
 * so it is correct whether the visitor is at /demo/, /demo/index.html or a deep hash route.
 * A `preview=<token>` on the page URL is threaded through: the worker serves an unapproved
 * bundle only to a caller holding that approve token.
 *
 * @param {string} id
 * @returns {string}
 */
function defUrl(id) {
  const url = new URL(`${id}/def.json`, import.meta.url);
  const preview = (new URLSearchParams(location.search).get('preview') || '').replace(/[^A-Za-z0-9._~-]/g, '');
  if (preview) url.searchParams.set('preview', preview);
  return url.toString();
}

/**
 * Fetch, gate and compose a generated robot.
 *
 * @param {string} id `g-<slug>`
 * @returns {Promise<object|null>} a RobotDefinition, or null (already logged) on any failure
 */
export async function loadGeneratedRobot(id) {
  if (!GEN_ID_RE.test(id)) {
    console.warn(`[generated] refusing "${id}": not a generated demo id`);
    return null;
  }

  let def;
  try {
    const res = await fetch(defUrl(id), { credentials: 'omit' });
    if (!res.ok) {
      console.warn(`[generated] ${id}: def.json returned ${res.status}`);
      return null;
    }
    def = await res.json();
  } catch (err) {
    console.warn(`[generated] ${id}: could not fetch or parse def.json (${err && err.message})`);
    return null;
  }

  const reason = gateReason(def);
  if (reason) {
    console.warn(`[generated] ${id}: rejected, ${reason}`);
    return null;
  }

  let buildScene;
  try {
    buildScene = buildSceneFromSpec(def.scene_spec);
  } catch (err) {
    console.warn(`[generated] ${id}: scene_spec would not compile (${err && err.message})`);
    return null;
  }

  return {
    id,
    // The machine's own short name, never the slug: everything that puts an identifier on screen
    // reads `deviceId || id`, so a visitor's demo can never read like a mailing-list token.
    deviceId: def.device_id,
    name: def.robot_name,
    device: def.device_line,
    tagline: def.tagline,
    accent: def.accent,
    seed: def.seed,
    duration: def.duration,
    rate: def.rate,
    channels: def.channels,
    findings: def.findings,
    firstQuestion: def.chat.first_question,
    suggested: def.chat.suggested,
    script: def.chat.script,
    // app.js hands buildData a prng seeded from the robot id. A generated robot ignores it: every
    // field's stream is rooted in the def's own `seed`, which is the seed the runner evaluated
    // the same spec with when it built the facts pack the analyst answers from.
    buildData: () => buildDataFromSpec(def),
    buildScene,
    generated: true,
  };
}
