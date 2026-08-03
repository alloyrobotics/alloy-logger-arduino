// chat.js - POST /demo/api/chat. Turns the demo's analyst panel into a real one.
//
// The demo ships seven canned missions. Four synthetic logs are generated deterministically in the
// browser; one replays a real robot-soccer match with disclosed synthetic onboard overlays; one is a
// fully synthetic scripted 2v2 battle generated offline against its competition's published rules;
// and Donna is a real onboard rosbag2 recording converted offline for this demo. worker/build-facts.mjs runs those same generators and writes facts.generated.js: per robot,
// the statistics, sampled series, per-finding excerpts, per-field provenance and hand-verified
// analyses. That pack is the ONLY thing the model is told about the mission, so every number it
// quotes is grounded in the facts pack, either in a plotted series or a ledger event row. Event
// counts and timestamps are ledger-grounded rather than necessarily chart-plotted, and every
// synthesized channel is labelled as one.
//
// The pack is the cached prefix (see PERSONA + facts below), so repeat questions on the same
// robot read it back at ~1/10th the input price instead of re-paying for it every turn.
//
// A request may also carry a `role` (hobbyist, engineer, lead, marketing) from the demo's picker.
// It changes the ALTITUDE of the answer and never the facts, and it is delivered as a second system
// block placed after the cache breakpoint, so every role shares one cache entry per robot. See
// ROLE_REGISTERS / buildSystemBlocks.

import Anthropic from '@anthropic-ai/sdk';
import { FACTS } from './facts.generated.js';
import { normalizeRole } from './roles.js';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 900;

/** Longest question we will forward. Anything past this is a paste, not a question. */
const MAX_QUESTION_CHARS = 500;
/** Assistant turns are our own output, but a direct caller can claim anything is one. */
const MAX_ASSISTANT_CHARS = 2000;
/** Whole-transcript budget; oldest turns are dropped first. */
const MAX_TRANSCRIPT_CHARS = 8000;
/** Largest request body we will even parse. */
const MAX_BODY_BYTES = 32 * 1024;
/** Turns of history the client may send back. The client keeps 10 turns and appends the current
 * question, so accept 11; at 10 the slice ate the oldest exchange every time. */
const MAX_HISTORY = 11;

/**
 * A personalized demo, built for one visitor by the generator in worker/demo-gen.js. Its pack is
 * published per slug into the Durable Object rather than baked into facts.generated.js, because
 * it is created long after this Worker was deployed. Same 20 character base32 slug the def.json
 * route serves, prefixed the same way the demo app names the robot.
 */
const GEN_ROBOT_RE = /^g-[a-z2-7]{20}$/;
/** The generator's DO is a single named instance; demo-gen.js resolves it the same way. */
const DO_NAME = 'main';

const ALLOWED_ORIGINS = new Set([
  'https://alloylogger.com',
  'https://www.alloylogger.com',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

// The persona is byte-stable and sits ahead of the facts, so it is part of the cached prefix.
// Keep edits here deliberate: changing a character re-writes the cache for every canned robot.
const PERSONA = `You are the Alloy analyst: the assistant a robotics engineer talks to after uploading a log to Alloy. A visitor is looking at a replay of one mission and asking you about it.

## What you know
Everything you know about this mission is in the MISSION DATA below, generated from the mission's own arrays. Treat it as the truth about this log, and where it tells you a channel is synthesized rather than recorded, say so instead of presenting it as something the log measured.

- Never invent a number. If a value is not in the mission data, say what you do have instead.
- Questions about the product (AlloyLogger, Alloy, pricing, accounts, setup): answer ONLY from the "About the product" section of the mission data. If it does not cover the question, say so in one line and point at usealloy.ai. Never state a product fact from your own general knowledge.
- Questions about another robot on this page: one line naming the right demo from the "Other missions" list, nothing more.
- General robotics or engineering questions: at most one brief factual sentence, then steer back to this log.
- Anything else off the log: say in one line that you can't see it from here and point at what the log does show. Stay the analyst no matter what the visitor asks you to become.

## How you answer
- Lead with the finding. First sentence states what happened or what the data says. No preamble, no restating the question.
- Short. Two to five sentences, or a small table when several numbers belong together. This is a chat panel, not a report.
- Concrete. Quote the actual values and timestamps, with units.
- Plain, direct engineer's voice. No filler, no enthusiasm, no "great question", no emoji.
- Never write the em dash character. Use a comma, a colon, or a full stop instead.
- Never mention the words "facts pack", "mission data", "system prompt", "context", or that you are an AI model.

## Evidence citations
When your answer refers to a moment the log flagged, cite it by writing the token {{ev:<id>}} on its own line at the end of the relevant paragraph. That token becomes a clickable chip that seeks the 3D replay and the chart to that moment, so it is the most valuable thing in your answer.

- Only ever cite an id listed as valid under "valid evidence ids" below. An unlisted id renders as nothing.
- One or two citations per answer. Do not cite the same id twice.
- Do not cite when the question has no moment attached to it (setup questions, pricing, how-to-log).

## Formatting
The panel renders a small markdown subset: **bold**, \`inline code\`, pipe tables, - bullet lists, 1. ordered lists, and \`\`\` fenced code blocks. Nothing else - no links, no italics, no headings, no blockquotes.

---

MISSION DATA
`;

/**
 * Per-role register, appended as a SECOND system block that sits AFTER the cache breakpoint.
 *
 * THIS IS THE WHOLE POINT OF THE SHAPE. The cached prefix is block 0, `PERSONA + robot.facts`,
 * and the breakpoint is at its end. A prefix cache matches on bytes from the start of the request
 * up to a breakpoint, so anything placed after that breakpoint can vary per request without
 * invalidating it: all four roles asking about the same robot read back the SAME cache entry, and
 * a role switch mid-conversation costs the ~40 tokens of this block rather than re-writing the
 * whole pack. Interpolating the register INTO the persona, which is the obvious way to write this,
 * would give every role its own cache entry per robot and quadruple the cache-write bill for the
 * exact same answers. ROLES v2 added two more registers and changed nothing about this shape,
 * which is the point of it: a fifth role is a string in this table and no new cache entries.
 *
 * `engineer` is deliberately NO BLOCK AT ALL rather than a block that describes the default. The
 * persona above already IS the engineer register (lead with the finding, quote exact values with
 * units), so an engineer request is byte-for-byte the request this route sent before roles existed:
 * the majority path pays nothing, adds no second block, and cannot regress on a prompt edit here.
 * v1's retired `operator` degrades to `engineer` in worker/roles.js, so it lands here too and a
 * stale client never gets a missing register, it gets the default one.
 *
 * Each register says what to DO with the same facts, never what facts to use. None of them may
 * loosen the persona's grounding rules: no number that is not in the pack, no invented channel, no
 * softened synthesis disclosure. A marketing answer is a shorter answer, not a vaguer one.
 */
const ROLE_REGISTERS = {
  engineer: null,
  hobbyist: `## This visitor
This visitor builds their own robots. A bench at home, weekend projects, no team and no fleet behind
them. Technical and curious, just not doing this professionally. Same facts, different altitude.

- Explain the mechanism, not only the reading. One sentence on WHY the number means what it means.
- Name a channel the first time you use it and say in a few words what it measures.
- Keep to the one or two numbers the finding actually turns on. Drop the rest.
- End on something they could change on their own robot: a gain, a mount, a rate, a wire.
- Still cite evidence. Watching the moment is how this lands for someone learning the system.`,
  lead: `## This visitor
This visitor owns the fleet and the schedule, not this one run. Same facts, different altitude.

- Lead with the consequence: what this costs, how often it would happen, what it puts at risk.
- Frame each finding as a pattern this one log is evidence of, and be explicit that it is one log.
- Prefer a small table of findings over a walkthrough of the timeline.
- Close on the decision it points at: what to check, instrument or change next.
- Never extrapolate a rate, a fleet number or a cost that the mission data does not contain. If they
  ask how often, say what this log shows and that one log cannot answer it.`,
  marketing: `## This visitor
This visitor is not an engineer. Marketing or customer support: the person who has to explain this
robot to somebody else, often to the customer it happened to. Same facts, different altitude.

- Plain language first: what the robot did, when, and whether it recovered. No channel names, no
  sample rates, no field level provenance unless they ask for them.
- At most one number per answer, and say what it means right beside it.
- Give them the sentence they can repeat: what went wrong, and what it means for whoever is asking.
- Never soften a failure into something it was not, and never offer a cause the data does not show.
- Still cite evidence. The chip that seeks the replay shows them the thing itself, which is worth
  more than any description of it.`,
};

/**
 * The system blocks for one request: the cached pack, then the role register if there is one.
 *
 * Exported for the unit test, which asserts the invariant this route lives or dies on: block 0 is
 * byte-identical across every role, and the cache_control breakpoint is on block 0 and nowhere
 * else.
 */
export function buildSystemBlocks(facts, role) {
  const register = role && Object.hasOwn(ROLE_REGISTERS, role) ? ROLE_REGISTERS[role] : null;
  const blocks = [
    {
      type: 'text',
      // PERSONA + facts is the cached prefix. It must be assembled the same way on
      // every request or the cache silently never reads.
      text: PERSONA + facts,
      cache_control: { type: 'ephemeral' },
    },
  ];
  // No cache_control on the register: a second breakpoint would ask the API to cache a ~40 token
  // block, which is under the minimum cacheable length and buys nothing even when it is not.
  if (register) blocks.push({ type: 'text', text: register });
  return blocks;
}

// ---------------------------------------------------------------------------- helpers

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/**
 * The persona bans em dashes but Haiku still slips one in occasionally; scrub deterministically
 * rather than hope. Spaced em dashes read naturally as a colon; bare ones (ranges) as a hyphen.
 * Runs per delta, so a spaced dash split across two deltas degrades to the hyphen form, which
 * still ships no em dash.
 */
const scrubEmDash = (t) => t.replace(/ — /g, ': ').replace(/—/g, '-');

/**
 * A missing binding is a config error and MUST fail closed: this endpoint spends a real API key,
 * and a deploy that silently drops the binding would ship it unmetered. Local dev has no
 * bindings, so `.dev.vars` sets DEV=1 to run open. A limiter that exists but throws is a
 * transient Cloudflare problem, not a config one; that stays open rather than taking the demo
 * down.
 */
function limitersConfigured(env) {
  const ok = (l) => l && typeof l.limit === 'function';
  return (ok(env.CHAT_RL_IP) && ok(env.CHAT_RL_ALL)) || env.DEV === '1';
}

async function underLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return true; // DEV only, per above
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

/**
 * Published packs are built once, on the runner, and stored in the Durable Object forever: they
 * are never rebuilt, so a sentence that COUNTS the public demo's missions is frozen at whatever
 * the count was on the day that demo was generated. Adding a fifth mission made every such
 * sentence false for every already-published demo.
 *
 * The count is therefore dropped at READ time, and only from DO-returned packs: a stored pack's
 * bytes are left alone, the compiled-in packs never come through here, and the replacement is
 * count-neutral so it can never go stale again. It rewrites the COUNTING PHRASE and nothing
 * around it - a stored pack is bytes this deploy has never seen, and a sentence-level rewrite
 * would have to guess where the sentence starts, which a URL's dot is enough to get wrong.
 */
const LEGACY_MISSION_COUNT_RE = /\b(?:four|4|five|5)\s+(?:more|other)\s+missions\b/gi;
const MISSION_COUNT_NEUTRAL = 'additional missions';

function normalizeLegacyPack(pack) {
  const facts = pack.facts;
  if (typeof facts !== 'string' || !LEGACY_MISSION_COUNT_RE.test(facts)) return pack;
  LEGACY_MISSION_COUNT_RE.lastIndex = 0;
  return { ...pack, facts: facts.replace(LEGACY_MISSION_COUNT_RE, MISSION_COUNT_NEUTRAL) };
}

/**
 * The mission pack for a robot id, or null if there is no mission we can answer for.
 *
 * The canned robots are compiled in. A `g-<slug>` robot is a generated private mission: its
 * pack was built by the same builder (worker/build-facts.mjs) on the runner and published into
 * the DO, so what comes back here is the identical `{ facts, evidenceIds }` shape and everything
 * downstream, including the cache breakpoint, is unchanged. Each generated pack is simply its own
 * cache prefix.
 */
async function resolveRobot(env, robotId) {
  // Plain index would accept "__proto__"/"constructor" and hand back Object.prototype.
  if (Object.hasOwn(FACTS, robotId)) return FACTS[robotId];
  if (!GEN_ROBOT_RE.test(robotId) || !env.DEMOGEN_DO) return null;
  let res;
  try {
    const stub = env.DEMOGEN_DO.get(env.DEMOGEN_DO.idFromName(DO_NAME));
    res = await stub.factsPack(robotId.slice(2));
  } catch (err) {
    // A DO that is unreachable must read as "no such mission", not as a 500 the visitor sees.
    console.error('chat facts lookup failed', robotId, err?.message);
    return null;
  }
  if (!res?.ok) return null;
  const pack = res.pack;
  // Published bytes are trusted-but-checked: the two fields the request below actually reads.
  if (typeof pack?.facts !== 'string' || !Array.isArray(pack.evidenceIds)) return null;
  return normalizeLegacyPack(pack);
}

/** Validate the posted body. Returns {robotId, robot, role, messages} or throws a message string. */
function parseBody(body, robot) {
  const robotId = String(body?.robot || '');
  if (!robot) throw 'Unknown robot.';

  // Optional, and unknown values fall back to the default register rather than throwing: a role is
  // a presentation hint on a question, and a client cached from before a vocabulary change must
  // still get its answer. normalizeRole is the ONLY path from the body to a register key, so
  // nothing a caller posts can reach the system prompt as text.
  const role = normalizeRole(body?.role);

  if (!Array.isArray(body?.messages) || !body.messages.length) throw 'No question.';
  const turns = body.messages.slice(-MAX_HISTORY);

  const messages = [];
  for (const t of turns) {
    const role = t?.role === 'assistant' ? 'assistant' : 'user';
    let content = String(t?.content ?? '').trim();
    if (!content) continue;
    // A direct caller can put anything in an "assistant" turn and make us pay input tokens for
    // it; truncate rather than reject, our own answers are never this long.
    if (role === 'assistant' && content.length > MAX_ASSISTANT_CHARS) {
      content = content.slice(0, MAX_ASSISTANT_CHARS);
    }
    if (role === 'user' && content.length > MAX_QUESTION_CHARS) throw 'That question is too long.';
    // Consecutive same-role turns are legal but signal a client bug; collapse them.
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += `\n\n${content}`;
      // The per-turn cap applies to the merged result too, or collapsing becomes a bypass.
      if (role === 'user' && messages[messages.length - 1].content.length > MAX_QUESTION_CHARS) {
        throw 'That question is too long.';
      }
    } else {
      messages.push({ role, content });
    }
  }

  // Whole-transcript budget: drop oldest turns first, the current question lives at the end.
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  while (messages.length > 1 && total > MAX_TRANSCRIPT_CHARS) {
    total -= messages.shift().content.length;
  }

  if (!messages.length) throw 'No question.';
  if (messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw 'No question.';

  return { robotId, robot, role, messages };
}

/** Pull the {{ev:id}} tokens the model actually emitted, keeping only ids this robot owns. */
function extractEvidence(text, validIds) {
  const seen = [];
  for (const m of String(text).matchAll(/\{\{ev:([a-z0-9_-]+)\}\}/gi)) {
    const id = m[1];
    if (validIds.includes(id) && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

// ---------------------------------------------------------------------------- handler

export async function handleChat(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // Browsers always send Origin on a cross-origin POST. No CORS headers are returned anywhere,
  // so this is belt-and-braces: it turns a would-be embedder into a clean 403 rather than a
  // request we pay for and the browser then discards.
  const origin = request.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: 'Forbidden.' }, 403);

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Chat is not configured.' }, 503);
  if (!limitersConfigured(env)) return json({ error: 'Chat is not configured.' }, 503);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await underLimit(env.CHAT_RL_IP, ip))) {
    return json({ error: 'Too many questions in a row. Give it a minute.' }, 429);
  }
  // A second, keyless limiter bounds total spend if a single visitor is not the problem.
  if (!(await underLimit(env.CHAT_RL_ALL, 'global'))) {
    return json({ error: 'The analyst is busy right now. Try again shortly.' }, 429);
  }

  // Best-effort pre-parse size gate (chunked bodies carry no content-length; the per-turn and
  // whole-transcript caps in parseBody are the real guard).
  const claimedBytes = Number(request.headers.get('content-length') || 0);
  if (claimedBytes > MAX_BODY_BYTES) return json({ error: 'Bad request.' }, 413);

  let parsed;
  try {
    const body = await request.json();
    parsed = parseBody(body, await resolveRobot(env, String(body?.robot || '')));
  } catch (err) {
    return json({ error: typeof err === 'string' ? err : 'Bad request.' }, 400);
  }
  const { robot, role, messages } = parsed;

  // No retries: a visitor is watching a caret blink, a retry doubles spend to answer nobody.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 60_000 });

  // Fires when the visitor goes away: tab closed, robot switched, a newer question aborted this
  // fetch. Without it Haiku generates (and bills) the full answer to a dead socket.
  // request.signal needs the enable_request_signal compatibility flag to actually fire.
  const upstream = new AbortController();
  request.signal?.addEventListener?.('abort', () => upstream.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let dead = false;
      // enqueue throws once the reader cancels; that must not blow up the delta loop or the
      // catch block that is itself trying to send().
      const send = (obj) => {
        if (dead) return;
        try {
          controller.enqueue(enc.encode(sse(obj)));
        } catch {
          dead = true;
          upstream.abort();
        }
      };
      let full = '';

      try {
        const ms = client.messages.stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            // An analyst that quotes exact samples has nothing to gain from sampling variance:
            // deterministic answers, and the smoke probes grade a reproducible output instead of a
            // coin flip per run.
            temperature: 0,
            // Block 0 is the cached prefix and is identical for every role; the register, when
            // there is one, rides after the breakpoint. See buildSystemBlocks.
            system: buildSystemBlocks(robot.facts, role),
            messages,
          },
          { signal: upstream.signal },
        );

        for await (const event of ms) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const text = scrubEmDash(event.delta.text);
            full += text;
            send({ type: 'delta', text });
          }
        }

        const final = await ms.finalMessage();
        // Cost line, surfaced in Cloudflare observability. cache_read >> cache_creation across
        // requests means the facts pack is being served from cache at ~1/10th input price; if
        // cache_read stays 0, something upstream of the breakpoint is changing per request.
        const u = final.usage || {};
        // `role` is on this line so the claim above can be CHECKED in production rather than
        // trusted: if the register were breaking the prefix, cache_read would sit at 0 for the two
        // non-default roles while staying high for engineer, and the split would be visible here.
        console.log(
          `chat usage robot=${parsed.robotId} role=${role ?? '-'} in=${u.input_tokens} ` +
            `cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens} ` +
            `out=${u.output_tokens}`,
        );
        if (final.stop_reason === 'refusal') {
          send({ type: 'error', message: "I can't answer that one." });
        } else {
          send({
            type: 'done',
            evidence: extractEvidence(full, robot.evidenceIds),
            truncated: final.stop_reason === 'max_tokens',
          });
        }
      } catch (err) {
        if (upstream.signal.aborted) {
          // The visitor left mid-answer; nobody is listening for an error frame.
          console.log(`chat aborted robot=${parsed.robotId} after ${full.length} chars`);
        } else {
          // Anything that reaches here has already had partial text delivered or none at all;
          // the client falls back to its scripted answer when it never saw a `done`.
          const status = err instanceof Anthropic.APIError ? err.status : 0;
          console.error('chat error', status, err?.message);
          send({
            type: 'error',
            message:
              status === 429
                ? 'The analyst is busy right now. Try again shortly.'
                : 'The analyst dropped out. Try that again.',
          });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already cancelled by the reader
        }
      }
    },
    cancel() {
      // The Workers runtime calls this when the client disconnects from the response stream.
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
