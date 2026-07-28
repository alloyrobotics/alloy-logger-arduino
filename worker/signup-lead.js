// signup-lead.js - the signup popup's capture endpoint, and the export path off the back of it.
//
// Two surfaces, two audiences:
//   public  POST /api/signup-lead        the popup's form. Same origin, no auth, 8 KB cap.
//   Hugh    GET  /api/signup-lead/list   bearer DEMOGEN_TOKEN. A page of the leads table as JSON,
//                                        newest first; the next page takes the compound cursor
//                                        `?before=<ISO created_at>&before_email=<email>`.
//
// This replaces nothing in worker/demo-gen.js: the generator's entry is shelved and stays shelved.
// It is a much smaller thing than a demo job. There is no state machine, no verification round
// trip and no link to sign. A row lands in `leads` and Hugh gets an email about it, and that is
// the entire feature.
//
// THE RESPONSE IS 202 OR IT IS NOTHING. A filled honeypot, an address already on the list and an
// IP past its daily cap all answer exactly like an accepted lead, because anything else turns this
// endpoint into an oracle: post an address, read the status, learn whether that person has already
// asked us for access. Only a body we could not parse and an address that is not an address get a
// 400, and both of those are things the visitor's own browser can see for itself.
//
// STORAGE IS THE SOURCE OF TRUTH, MAIL IS A NOTIFICATION. The Resend call runs inside
// ctx.waitUntil after the response is already out, and every failure path inside it is caught and
// logged. A lead is never lost because a mail provider was unhappy, and a visitor is never made to
// wait on one.
//
// EVERY CEILING IS A SILENT 202. There are four of them and they nest, cheapest first: the two
// edge limiters (LEAD_RL_IP, LEAD_RL_ALL) run before the body is even read, the per-IP daily cap
// and the global daily cap run inside the DO. Nothing past a ceiling writes a row, sends a mail or
// answers differently from an accepted lead.

const DO_NAME = "main";

/** The popup posts about 200 bytes. 8 KB is room for a long src plus slack, and no more. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_EMAIL_LEN = 254;
/** Same address shape demo-gen used. Single line and ASCII by construction, which is what makes it
 *  safe to drop straight into a mail subject and a reply-to header. */
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;

/** New leads one IP may create per rolling day before it starts being answered with a silent 202. */
const IP_CAP_PER_DAY = 5;
const IP_WINDOW_MS = 86_400_000;

/**
 * NEW leads this route will accept in one UTC day, across every IP.
 *
 * The per-IP cap bounds one visitor. This bounds the table, the notification volume and the DO's
 * write rate against a flood spread thin enough that no single address ever trips that cap. It is
 * the last of the four ceilings and the only one that is global and durable: the edge limiters are
 * per-POP and per-minute, so they cannot answer "how many rows can one day add".
 */
const LEAD_DAILY_CAP = 500;

/**
 * Notification emails per UTC day, counted in the DO beside the daily cap.
 *
 * Past it the lead is STILL STORED and only the mail is skipped. The row is the record and the
 * email is a nudge, so the failure mode to avoid is not a missing row, it is 500 nudges in one
 * morning training Hugh to filter the whole thread away.
 */
const NOTIFY_BUDGET_PER_DAY = 25;

/**
 * Number.isFinite rather than `|| LEAD_DAILY_CAP`, and the same reading do.js gives
 * DEMOGEN_MAX_JOBS_PER_DAY: `DEMOGEN_LEAD_DAILY_CAP=0` is a deliberate pause of the capture, not a
 * typo that should silently restore the default.
 */
function leadDailyCap(env) {
  const raw = Number(env.DEMOGEN_LEAD_DAILY_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : LEAD_DAILY_CAP;
}

/** Free-text fields that ride along for attribution. Trimmed to something a chart can hold. */
const MAX_TAG_LEN = 64;
/** Longest sane dwell to store: anything past a day is a tab left open, not engagement. */
const MAX_DWELL_MS = 86_400_000;
/**
 * Rows one list call returns. The table is a lead list, not a dataset, so the page stays small and
 * the whole thing comes out through `?before=` rather than through an ever-growing single response.
 */
const MAX_LIST = 1000;

const NOTIFY_TO = "hughphan2@gmail.com";
const FALLBACK_FROM = "Hugh at Alloy <hugh@alloylogger.com>";

const NO_STORE = { "cache-control": "no-store" };

const enc = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
  });
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}

/** Constant time over equal-length ascii; length is not a secret here. Same shape demo-gen uses. */
function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** The runner routes' bearer check, verbatim: missing secret is a refusal, not a bypass. */
function bearerOk(request, env) {
  const want = env.DEMOGEN_TOKEN;
  if (!want) return false;
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(got, String(want));
}

function stub(env) {
  return env.DEMOGEN_DO.get(env.DEMOGEN_DO.idFromName(DO_NAME));
}

/**
 * The salt for the IP hash. The raw IP is never stored: the DO only ever sees this digest, and
 * keying it with the signing secret is what stops it being reversible by rainbow table over the
 * v4 space.
 *
 * Deliberately NOT the fail-loud `signingKey()` demo-gen uses for its signed links. There, an
 * absent key means every link verifies and the only safe answer is to throw. Here it means one
 * rate-limit bucket is unkeyed, and throwing would drop a real lead over a misconfiguration the
 * visitor cannot see or fix. So it degrades, loudly in the log, and the capture still lands.
 */
function ipSalt(env) {
  const key = env.DEMOGEN_SIGNING_KEY;
  if (key && String(key).length >= 16) return String(key);
  console.log("[signup-lead] DEMOGEN_SIGNING_KEY missing or too short; ip hash is unkeyed");
  return "signup-lead-unkeyed";
}

// ------------------------------------------------------------------ edge rate limits

/**
 * A missing binding is a config error and MUST fail closed, exactly as chat.js reads it.
 *
 * chat.js fails closed because the route behind it spends a real API key. This one fails closed
 * because the route behind it reaches a Durable Object on every post: a deploy that dropped these
 * bindings would ship an unmetered public write path to the DO, and the daily caps inside the DO
 * cannot help, because reaching them is already the round trip worth bounding.
 *
 * Local dev has no ratelimit bindings on every wrangler version, so `.dev.vars` sets DEV=1 and this
 * runs open, the same escape hatch and the same var chat.js uses.
 */
function limitersConfigured(env) {
  const ok = (l) => l && typeof l.limit === "function";
  return (ok(env.LEAD_RL_IP) && ok(env.LEAD_RL_ALL)) || env.DEV === "1";
}

/**
 * A limiter that EXISTS but throws is a transient Cloudflare problem, not a config one, so it runs
 * open rather than turning a provider blip into a lost lead. A limiter that is absent is only ever
 * reached under DEV=1, because limitersConfigured() refused the request otherwise.
 */
async function underLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== "function") return true; // DEV only, per above
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

// ------------------------------------------------------------------ body

/**
 * The request body as text, or null if it is over the cap or could not be read.
 *
 * `request.text()` cannot do this job. It buffers the WHOLE body before anything is in a position
 * to measure it, so a `Transfer-Encoding: chunked` post, which carries no Content-Length at all,
 * would be allocated in full and only then measured: the cap would be enforced after the
 * allocation it exists to prevent. This reads the stream itself and cancels the moment the running
 * total would pass the cap, so at most MAX_BODY_BYTES is ever held and the chunk that tripped the
 * gate is never retained.
 *
 * The Content-Length fast reject stays in front of it: when a sender does declare a length, a
 * refusal on the header costs no read at all.
 */
async function readCappedBody(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const stream = request.body;
  // A POST with no body at all. Empty text falls straight through to the bad_json path below,
  // which is what an empty body is.
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      // Measured BEFORE the chunk is kept, so an oversized chunk is dropped rather than stored,
      // and the reader is cancelled rather than drained: the rest of the body is never pulled
      // across at all.
      if (total + value.byteLength > MAX_BODY_BYTES) {
        await reader.cancel("body over cap").catch(() => {});
        return null;
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } catch {
    // A body that dies mid-read (client gone, malformed chunking) is not a body we can parse, and
    // it is the visitor's own connection that failed, so it gets the same answer as bad JSON.
    return null;
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Attribution text, reduced to something that cannot be a header or a script. */
function tag(value) {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, MAX_TAG_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

// ------------------------------------------------------------------ notification

/**
 * One plain-text email to Hugh per NEW lead, and never for a duplicate: a second notification for
 * an address already on the list is noise that trains him to ignore the first one.
 *
 * Every exit is `{ ok }`, never a throw. This runs inside `ctx.waitUntil` with the 202 already
 * sent, so a rejection here would surface as an unhandled runtime error attached to a request that
 * succeeded, and would tell nobody anything.
 */
async function sendLeadNotification(env, { email, robot, src, dwellMs, at }) {
  const subject = `AlloyLogger lead: ${email}`;
  const text = `New signup from the demo popup.

Email:  ${email}
Robot:  ${robot ?? "-"}
Source: ${src ?? "-"}
Dwell:  ${dwellMs == null ? "-" : `${dwellMs} ms in the popup`}
At:     ${new Date(at).toISOString()}

The full list:
curl -s -H "authorization: Bearer $DEMOGEN_TOKEN" https://alloylogger.com/api/signup-lead/list
`;

  // The same dev guard the shelved verification mail used, and the same reason for it: local
  // wrangler runs must not spend a real send, and a deploy missing the key must log rather than
  // fail silently.
  if (env.DEMOGEN_DEV_NO_EMAIL === "1" || !env.DEMOGEN_RESEND_KEY) {
    console.log(`[signup-lead] notification suppressed lead=${email} robot=${robot ?? "-"} src=${src ?? "-"}`);
    return { ok: true, suppressed: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.DEMOGEN_RESEND_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.DEMOGEN_FROM || FALLBACK_FROM,
        to: [NOTIFY_TO],
        // Replying to the notification replies to the lead. The address passed EMAIL_RE, so it is
        // single line ASCII and cannot smuggle a header.
        reply_to: email,
        subject,
        text,
      }),
      // A Resend call that never answers would hold the waitUntil open until the runtime kills it.
      // Fail fast and log instead.
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`[signup-lead] resend ${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);
      return { ok: false, error: `resend ${res.status}` };
    }
    return { ok: true, id: payload.id };
  } catch (err) {
    console.log(`[signup-lead] resend threw: ${String(err?.message ?? err)}`);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ------------------------------------------------------------------ POST /api/signup-lead

async function handleCapture(request, env, ctx) {
  if (!limitersConfigured(env)) return json({ ok: false, error: "not configured" }, 503);

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";

  // Both limiters run BEFORE the body is read and long before the DO is touched, so a flood costs
  // this Worker two header lookups and nothing else. Cloudflare's limiter counters are per-POP,
  // permissive and eventually consistent, so this bounds DO traffic to roughly the configured
  // rates rather than exactly; the durable daily cap inside the DO is the exact backstop.
  //
  // Over-limit answers 202, exactly like the honeypot and the daily caps. A 429 would tell a bot
  // where the wall is and tell a scraper that its address probe was the request that got counted;
  // the whole point of the single-answer rule is that no ceiling is observable from outside.
  if (!(await underLimit(env.LEAD_RL_IP, ip))) {
    console.log("[signup-lead] rl-drop ip");
    return json({ ok: true }, 202);
  }
  // A second, keyless limiter bounds the route as a whole when one visitor is not the problem.
  if (!(await underLimit(env.LEAD_RL_ALL, "global"))) {
    console.log("[signup-lead] rl-drop global");
    return json({ ok: true }, 202);
  }

  const raw = await readCappedBody(request);
  if (raw === null) return json({ ok: false, reason: "bad_json" }, 400);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, reason: "bad_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, reason: "bad_json" }, 400);
  }

  // Honeypot, and it is checked FIRST for a reason: a bot that filled the hidden field must not be
  // able to tell a filled honeypot from a rejected address by sending a bad one on purpose. It also
  // costs nothing after this point: no DO round trip, no row, no mail, no counter.
  const hp = body.hp;
  if (hp != null && String(hp).trim().length > 0) {
    console.log("[signup-lead] honeypot");
    return json({ ok: true }, 202);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return json({ ok: false, reason: "bad_email" }, 400);
  }

  const dwellRaw = Number(body.dwell_ms);
  const dwellMs = Number.isFinite(dwellRaw) ? Math.min(Math.max(Math.round(dwellRaw), 0), MAX_DWELL_MS) : null;
  const robot = tag(body.robot);
  const src = tag(body.src);

  const ipHash = (await sha256Hex(`${ip}${ipSalt(env)}`)).slice(0, 32);
  const now = Date.now();

  const res = await stub(env).recordLead({
    email,
    robot,
    src,
    dwellMs,
    ipHash,
    now,
    ipCap: IP_CAP_PER_DAY,
    windowMs: IP_WINDOW_MS,
    dailyCap: leadDailyCap(env),
    notifyBudget: NOTIFY_BUDGET_PER_DAY,
  });

  // Only a genuinely new row is worth an email. `duplicate` already sent one when it was new, and
  // neither `capped` nor `daily_capped` ever became a row at all. `notify` is the DO's answer to
  // "is there budget left today", decided in the same atomic call that wrote the row, so two
  // simultaneous leads cannot both read the last slot as free.
  if (res.status === "new" && res.notify) {
    ctx.waitUntil(sendLeadNotification(env, { email, robot, src, dwellMs, at: now }));
  } else if (res.status === "new") {
    // Stored and deliberately unmailed. The row is in the export either way, so this is a quieter
    // inbox and not a lost lead.
    console.log(`[signup-lead] notify-budget lead=${email}`);
  } else {
    console.log(`[signup-lead] ${res.status}`);
  }

  return json({ ok: true }, 202);
}

// ------------------------------------------------------------------ GET /api/signup-lead/list

async function handleList(request, env, url) {
  // Bearer before method, exactly as handleRunner does it: an unauthorized caller learns the same
  // thing whatever verb it used.
  if (!bearerOk(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (request.method !== "GET") return json({ ok: false, reason: "method_not_allowed" }, 405);

  // `?before=<ISO created_at>&before_email=<email>` is the compound cursor the previous page
  // handed back; paste both query params into the next curl. A cursor that is not a date is a 400
  // rather than a silently ignored filter: ignoring it would serve page one forever and read
  // exactly like a list that had stopped growing, which is the one wrong answer an export must
  // never give. `before_email` alone (without `before`) is equally malformed.
  const beforeRaw = url.searchParams.get("before");
  const beforeEmail = url.searchParams.get("before_email");
  let before = null;
  if (beforeRaw != null) {
    const ms = Date.parse(beforeRaw);
    if (!Number.isFinite(ms)) return json({ ok: false, reason: "bad_cursor" }, 400);
    before = ms;
  } else if (beforeEmail != null) {
    return json({ ok: false, reason: "bad_cursor" }, 400);
  }

  // One row past the page is asked for and never returned. It exists only so "is there more" is
  // an observed fact rather than the guess "a full page probably means more".
  const rows = await stub(env).listLeads(MAX_LIST + 1, before, beforeEmail);
  const truncated = rows.length > MAX_LIST;
  const leads = truncated ? rows.slice(0, MAX_LIST) : rows;
  const last = truncated ? leads[leads.length - 1] : null;

  return json(
    {
      ok: true,
      count: leads.length,
      // The compound cursor for the next page, null when this is the last one. The ordering is
      // (created_at DESC, email DESC) and email is unique, so the position is exact: a millisecond
      // shared across a page boundary cannot repeat a row here or hide one there. Both halves must
      // be sent back together.
      next_before: last ? last.created_at : null,
      next_before_email: last ? last.email : null,
      leads,
    },
    200,
  );
}

// ------------------------------------------------------------------ entry point

export default async function handleSignupLead(request, env, ctx, url) {
  try {
    if (url.pathname === "/api/signup-lead/list") return await handleList(request, env, url);
    if (url.pathname === "/api/signup-lead") {
      if (request.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
      return await handleCapture(request, env, ctx);
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (err) {
    console.log(`[signup-lead] ${request.method} ${url.pathname} threw: ${String(err?.stack ?? err)}`);
    return json({ ok: false, error: "server error" }, 500);
  }
}
