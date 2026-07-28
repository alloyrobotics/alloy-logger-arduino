// demo-gen.js - every HTTP surface of the personalized-demo generator.
//
// Three audiences, three auth models:
//   public   /api/demo-gen/{submit,verify,unsubscribe} + /demo/js/robots/g-<slug>/def.json
//            No auth. Generic responses on purpose: a visitor learns nothing about whether
//            an address is known, suppressed, rate limited or a duplicate.
//   runner   /api/demo-gen/runner/*  Bearer DEMOGEN_TOKEN, constant-time compare.
//   Hugh     /api/demo-gen/{approve,reject}?t=  Per-job single-use HMAC links, phone sized.
//            NOT the runner bearer: these arrive in a Slack DM and get scanned by bots, so
//            the GET only renders a confirm page and the POST is what commits.
//
// All state lives in DemoGenDO (worker/do.js). This file validates, hashes, signs, renders
// and never keeps anything.

const DO_NAME = "main";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_DEF_BYTES = 128 * 1024;
const MAX_FACTS_BYTES = 256 * 1024;
const MIN_DWELL_MS = 2500;
const VERIFY_TTL_MS = 7 * 86_400_000;
const APPROVE_TTL_MS = 7 * 86_400_000;

const SLUG_RE = /^[a-z2-7]{20}$/;
const JOB_ID_RE = /^[a-z2-7]{22}$/;
// Conservative on purpose: a rejected odd-but-real address costs one lead, an accepted
// garbage address costs an Opus job and a deliverability hit.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
const ROBOTS_SEEN = new Set(["sbr", "arm6", "drone", "rescue"]);
const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{1,22}$/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const CHANNEL_PATH_RE = /^\/[a-z][a-z0-9_]{0,15}$/;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;
const FINDING_ID_RE = /^[a-z0-9-]{2,24}$/;

const DEFAULT_ORIGIN = "https://alloylogger.com";
const FALLBACK_FROM = "Hugh at Alloy <hugh@alloylogger.com>";

// ------------------------------------------------------------------ tiny helpers

const NO_STORE = { "cache-control": "no-store" };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...extra },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE } });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** One self-contained dark page, inline styles only. No CDN, no fonts, no external script. */
function page(title, headline, bodyHtml, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#111;color:#e8e8e8;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<main style="max-width:34rem;margin:0 auto;padding:3rem 1.25rem">
<h1 style="font-size:1.375rem;font-weight:600;margin:0 0 1rem;color:#fff">${esc(headline)}</h1>
${bodyHtml}
<p style="margin-top:2.5rem;font-size:0.875rem;color:#8a8a8a">
<a href="${DEFAULT_ORIGIN}/demo/" style="color:#61d4a3">alloylogger.com/demo</a>
</p>
</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
}

function p(text) {
  return `<p style="margin:0 0 1rem;color:#c9c9c9">${esc(text)}</p>`;
}

const BUTTON_STYLE =
  "width:100%;padding:0.9rem 1rem;font-size:1rem;font-weight:600;color:#111;border:0;border-radius:0.625rem;cursor:pointer";

/**
 * A GET that would otherwise commit something, rendered as a one-button POST form instead.
 *
 * Mail providers and chat clients prefetch every link in a message, so a GET that mutates state
 * gets "clicked" by a scanner before the human ever sees it. The form below is the commit, and
 * the inline script submits it on load: a real browser confirms in one frame and the visitor sees
 * only the result, while a scanner that fetches the HTML without running JS commits nothing.
 * The visible button is what a visitor with JS disabled uses, and it is the whole reason the
 * script is an enhancement rather than the mechanism.
 */
function confirmPage(title, headline, intro, buttonLabel, action, colour = "#61d4a3") {
  const body = `${p(intro)}
<form method="POST" action="${esc(action)}" id="confirm-form" style="margin:0">
<button type="submit" style="${BUTTON_STYLE};background:${colour}">${esc(buttonLabel)}</button>
</form>
<script>document.getElementById('confirm-form').submit();</script>`;
  return page(title, headline, body);
}

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}

async function hmacHex(key, message) {
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
}

/** Constant time over equal-length hex/ascii; length is not a secret here. */
function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Signed link token. `subject` is a job id (verify/approve/reject) or an email (unsub).
 * expiry 0 means no expiry, which is only ever used for unsubscribe: an unsubscribe link
 * that stops working is a compliance problem, not a security win.
 */
async function makeToken(env, purpose, subject, ttlMs) {
  const expiry = ttlMs > 0 ? Date.now() + ttlMs : 0;
  const sig = await hmacHex(signingKey(env), `${subject}|${expiry}|${purpose}`);
  return b64urlEncode(`${subject}.${expiry}.${sig}`);
}

async function readToken(env, purpose, token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
  let raw;
  try {
    raw = b64urlDecode(token);
  } catch {
    return null;
  }
  // The subject can contain dots (an email address does), so split from the right.
  const lastDot = raw.lastIndexOf(".");
  if (lastDot < 0) return null;
  const sig = raw.slice(lastDot + 1);
  const prevDot = raw.lastIndexOf(".", lastDot - 1);
  if (prevDot < 0) return null;
  const expiry = Number(raw.slice(prevDot + 1, lastDot));
  const subject = raw.slice(0, prevDot);
  if (!subject || !Number.isFinite(expiry)) return null;
  const want = await hmacHex(signingKey(env), `${subject}|${expiry}|${purpose}`);
  if (!timingSafeEqual(sig, want)) return null;
  if (expiry !== 0 && Date.now() > expiry) return null;
  return { subject, expiry };
}

function signingKey(env) {
  // Fail loud rather than silently signing with "undefined": every link would verify.
  const key = env.DEMOGEN_SIGNING_KEY;
  if (!key || String(key).length < 16) throw new Error("DEMOGEN_SIGNING_KEY missing or too short");
  return String(key);
}

function originOf(env) {
  // Production leaves DEMOGEN_ORIGIN unset and gets the literal apex. `wrangler dev` sets
  // it so the emailed links point at localhost instead of the live site.
  return String(env.DEMOGEN_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");
}

function stub(env) {
  return env.DEMOGEN_DO.get(env.DEMOGEN_DO.idFromName(DO_NAME));
}

/** Strip C0/C1 controls but keep newline and tab, then collapse the runs of blank space. */
function cleanUseCase(raw) {
  return String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeForDedupe(useCase) {
  return useCase.toLowerCase().replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ email

/**
 * The only email this Worker sends. Everything else (ready / apology / refusal) is the
 * runner's mailer, because those need job artifacts this Worker never sees.
 * The body is fixed code; the only interpolations are the visitor's own words and a
 * server-constructed link.
 */
async function sendVerificationEmail(env, { to, useCase, link }) {
  const subject = "Confirm your Alloy demo build";
  const body = `You asked for a personalized demo of Alloy for:

  "${useCase.slice(0, 120)}"

Click to confirm and we start building:
${link}

We only use your email to send you this demo. If this wasn't you, ignore this and nothing happens.
`;

  if (env.DEMOGEN_DEV_NO_EMAIL === "1" || !env.DEMOGEN_RESEND_KEY) {
    // Local dev and any misconfigured deploy: log instead of dropping silently, so the
    // verify link is still reachable from the wrangler dev console.
    console.log(`[demo-gen] verification email suppressed to=${to} link=${link}`);
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
        to: [to],
        reply_to: "hugh@usealloy.ai",
        subject,
        text: body,
      }),
      // A Resend call that never answers would hold the waitUntil open until the runtime
      // kills it, and the job would sit in `unverified` with no event either way. Fail fast
      // and record the failure instead.
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`[demo-gen] resend ${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);
      return { ok: false, error: `resend ${res.status}` };
    }
    return { ok: true, id: payload.id };
  } catch (err) {
    console.log(`[demo-gen] resend threw: ${String(err?.message ?? err)}`);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ------------------------------------------------------------------ public: submit

async function handleSubmit(request, env, ctx) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return json({ ok: false, reason: "invalid" }, 415);

  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > MAX_BODY_BYTES) return json({ ok: false, reason: "invalid" }, 413);

  const raw = await request.text();
  if (enc.encode(raw).byteLength > MAX_BODY_BYTES) return json({ ok: false, reason: "invalid" }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, reason: "invalid" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, reason: "invalid" }, 400);

  const do_ = stub(env);

  // Bot front line. Both answer exactly like a success so a scripted submitter learns
  // nothing from the response, and neither creates a job row.
  if (typeof body.website === "string" && body.website.trim().length > 0) {
    ctx.waitUntil(do_.note("honeypot"));
    return json({ ok: true }, 202);
  }
  const dwell = Number(body.dwell_ms);
  if (!Number.isFinite(dwell) || dwell < MIN_DWELL_MS) {
    ctx.waitUntil(do_.note("dwell_block"));
    return json({ ok: true }, 202);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ ok: false, reason: "invalid" }, 400);
  }

  const useCase = cleanUseCase(body.use_case);
  if (useCase.length < 40 || useCase.length > 600) return json({ ok: false, reason: "invalid" }, 400);
  if (useCase.split(/\s+/).filter(Boolean).length < 5) return json({ ok: false, reason: "invalid" }, 400);

  const robotSeen = body.robot_seen == null || body.robot_seen === "" ? null : String(body.robot_seen);
  if (robotSeen !== null && !ROBOTS_SEEN.has(robotSeen)) return json({ ok: false, reason: "invalid" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  // The raw IP is never stored: the DO only ever sees this hash, and the hash is keyed so
  // it is not reversible by rainbow table over the v4 space.
  const ipHash = (await sha256Hex(`${ip}${signingKey(env)}`)).slice(0, 32);
  const emailHash = (await sha256Hex(`${email}${signingKey(env)}`)).slice(0, 32);
  const dedupeKey = await sha256Hex(`${email}|${normalizeForDedupe(useCase)}`);
  const ua = (request.headers.get("user-agent") || "").slice(0, 200);

  const result = await do_.submit({
    email,
    emailHash,
    useCase,
    robotSeen,
    ipHash,
    ua,
    dedupeKey,
    now: Date.now(),
  });

  if (result.ok === false && result.reason === "rate") return json({ ok: false, reason: "rate" }, 429);
  if (result.suppressed) return json({ ok: true }, 202); // silent: an unsubscribe stays honoured
  if (result.duplicate) return json({ ok: true, duplicate: true }, 202);

  const token = await makeToken(env, "verify", result.job.id, VERIFY_TTL_MS);
  const link = `${originOf(env)}/api/demo-gen/verify?t=${token}`;
  // Sent after the response, so a slow Resend never becomes a slow form. The outcome is
  // still counted: verify_mail_failed is the alarm for "leads captured, nothing delivered".
  ctx.waitUntil(
    sendVerificationEmail(env, { to: email, useCase, link }).then((mail) =>
      // Fresh stub: the one above was handed out before the send and does not need to
      // survive it.
      stub(env).note(mail.ok ? "verify_mail_sent" : "verify_mail_failed", result.job.id),
    ),
  );

  // 202 either way: the job exists and the address is captured, and telling a visitor that
  // our mail provider is unhappy helps nobody.
  return json({ ok: true }, 202);
}

// ------------------------------------------------------------------ public: verify

async function handleVerify(request, env, url) {
  const token = url.searchParams.get("t") || "";
  const claim = await readToken(env, "verify", token);
  if (!claim || !JOB_ID_RE.test(claim.subject)) {
    return page("Link not valid", "That link is not valid", p("It may have expired, or been copied incompletely. Ask for a demo again and we will send a fresh one."), 400);
  }

  // The GET only renders. A mail scanner that follows the link without running JS confirms
  // nothing, which matters because a scanner-confirmed address is a lead we would build a demo
  // for that no human ever asked to confirm.
  if (request.method === "GET") {
    return confirmPage(
      "Confirm your demo",
      "One tap to confirm",
      "Confirm this is you and we start building your demo.",
      "Yes, build my demo",
      `/api/demo-gen/verify?t=${token}`,
    );
  }

  const res = await stub(env).verify(claim.subject, Date.now());
  if (res.status === "unknown") {
    return page("Link not valid", "That link is not valid", p("We have no record of that request. Ask for a demo again and we will send a fresh one."), 400);
  }
  if (res.status === "already") {
    return page("Already confirmed", "Already confirmed", p("You have confirmed this one. The link lands in your inbox when the demo is built."));
  }
  return page(
    "Confirmed",
    "You're confirmed",
    p("We're building your demo now. The link lands in your inbox, usually within a few hours."),
  );
}

// ------------------------------------------------------------------ public: unsubscribe

async function handleUnsubscribe(request, env, url) {
  const token = url.searchParams.get("t") || "";
  const claim = await readToken(env, "unsub", token);
  if (!claim) {
    return page("Link not valid", "That link is not valid", p("Reply to any of our emails and we will take you off the list by hand."), 400);
  }
  // Same GET/POST split as verify. Suppression is not destructive, but a scanner silently
  // unsubscribing a visitor is still a lead lost to a robot, and the auto-submitting form costs
  // the human nothing.
  if (request.method === "GET") {
    return confirmPage(
      "Unsubscribe",
      "Take me off the list",
      "Confirm and this address comes off the list for good.",
      "Unsubscribe me",
      `/api/demo-gen/unsubscribe?t=${token}`,
      "#e0705c",
    );
  }
  await stub(env).suppress(claim.subject.toLowerCase(), Date.now());
  return page("Unsubscribed", "You won't hear from us again", p("That address is off the list. Nothing further will be sent to it."));
}

// ------------------------------------------------------------------ public: def.json

async function handleDefJson(request, env, ctx, url, slug, file) {
  if (!SLUG_RE.test(slug)) return textResponse("not found", 404);

  // Does this slug belong to a job at all? If not, the path is not a generated demo and the
  // request goes back to the asset handler. That matters because the demo app commits a
  // hand-written g-<slug> bundle as its loader fixture, and this route would otherwise
  // shadow it. A slug the DO DOES know never falls through, whatever its state.
  const probe = await stub(env).bundle(slug);
  if (!probe.ok && probe.error === "not_found") return env.ASSETS.fetch(request);

  // Exactly one file is servable out of the DO. Anything else under a real generated slug is
  // a 404, so a bundle directory can never become a general purpose static host.
  if (file !== "/def.json") return textResponse("not found", 404);

  // Preview: the same signed approve token, so Hugh can look at the demo from the confirm
  // page BEFORE approving it. Nobody else can construct one, and it never caches.
  let preview = false;
  const previewToken = url.searchParams.get("preview");
  if (previewToken) {
    const claim = await readToken(env, "approve", previewToken);
    if (claim && JOB_ID_RE.test(claim.subject)) {
      const owned = await stub(env).slugFor(claim.subject);
      preview = owned === slug;
    }
    if (!preview) return textResponse("not found", 404);
  }

  const res = preview ? await stub(env).bundle(slug, { preview: true }) : probe;
  if (!res.ok) return textResponse("not found", 404);

  ctx.waitUntil(stub(env).note("gen_view", res.job_id)); // undercounts behind the edge cache, by design

  return new Response(res.def_json, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": preview ? "no-store" : "public, max-age=3600",
      "cache-tag": `demogen-${slug}`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

// ------------------------------------------------------------------ approval links

/**
 * The three signed links a claim or review row hands the runner. The Worker mints them because
 * the Worker owns the signing key: the runner has no way to construct an approval URL and must
 * use these verbatim.
 *
 * `preview_url` puts `?preview=` BEFORE the `#`, because everything after the hash goes to the
 * demo app's router and `generated.js` reads the token out of `location.search`.
 */
async function approvalLinks(env, jobId, slug) {
  const origin = originOf(env);
  const approveToken = await makeToken(env, "approve", jobId, APPROVE_TTL_MS);
  const rejectToken = await makeToken(env, "reject", jobId, APPROVE_TTL_MS);
  return {
    approve_url: `${origin}/api/demo-gen/approve?t=${approveToken}`,
    reject_url: `${origin}/api/demo-gen/reject?t=${rejectToken}`,
    preview_url: `${origin}/demo/?preview=${encodeURIComponent(approveToken)}#/connect/g-${slug}`,
  };
}

/**
 * `token` is the token that got Hugh to THIS page, whose purpose matches `kind`. The preview and
 * raw-def links always need an APPROVE purpose token, so the reject page mints its own: the page
 * kind and the purpose of the links on it are independent, and a reject page you cannot look at
 * the demo from is a reject page you cannot make a decision on.
 */
async function approvalPage(kind, view, token, env) {
  const job = view.job;
  const slug = job.slug;
  const approveToken = kind === "approve" ? token : await makeToken(env, "approve", job.id, APPROVE_TTL_MS);
  const previewUrl = `${originOf(env)}/demo/?preview=${encodeURIComponent(approveToken)}#/connect/g-${slug}`;
  const defUrl = `${originOf(env)}/demo/js/robots/g-${slug}/def.json?preview=${encodeURIComponent(approveToken)}`;
  const verb = kind === "approve" ? "Approve and send" : "Reject and delete";
  const colour = kind === "approve" ? "#61d4a3" : "#e0705c";

  const row = (label, value) =>
    `<div style="margin:0 0 0.875rem"><div style="font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;color:#8a8a8a">${esc(label)}</div><div style="color:#e8e8e8;word-break:break-word">${esc(value ?? "-")}</div></div>`;

  const body = `
<div style="background:#191919;border:1px solid #2a2a2a;border-radius:0.75rem;padding:1.25rem;margin:0 0 1.5rem">
${row("Robot", job.robot_name)}
${row("Email summary", job.email_summary)}
${row("Their use case", job.use_case)}
${row("Sends to", job.email)}
${row("State", job.state)}
${view.bundle ? row("Bundle", `${view.bundle.bytes} bytes, sha256 ${String(view.bundle.sha256).slice(0, 16)}`) : ""}
</div>
<p style="margin:0 0 1.5rem"><a href="${esc(previewUrl)}" style="color:#61d4a3">Open the demo preview</a>
<span style="color:#8a8a8a"> / </span><a href="${esc(defUrl)}" style="color:#8a8a8a">raw def.json</a></p>
<form method="POST" action="/api/demo-gen/${kind}?t=${esc(token)}" style="margin:0">
<button type="submit" style="${BUTTON_STYLE};background:${colour}">${esc(verb)}</button>
</form>`;

  return page(
    kind === "approve" ? "Approve demo" : "Reject demo",
    kind === "approve" ? "Send this demo?" : "Reject this demo?",
    body,
  );
}

async function handleApproval(request, env, url, kind) {
  const token = url.searchParams.get("t") || "";
  const claim = await readToken(env, kind === "approve" ? "approve" : "reject", token);
  if (!claim || !JOB_ID_RE.test(claim.subject)) {
    return page("Link not valid", "That link is not valid", p("It may have expired. Ask for a fresh approval link."), 400);
  }

  const view = await stub(env).approvalView(claim.subject);
  if (!view.ok) return page("Not found", "No such job", p("Nothing to act on."), 404);

  if (request.method === "GET") {
    // A link scanner following the GET must not be able to commit anything, so this only
    // ever renders. The POST below is the action.
    if (view.job.state !== "generated" && !(kind === "reject" && view.job.state === "approved")) {
      return page("Already handled", "Already handled", p(`This job is in state "${view.job.state}". Nothing left to do here.`));
    }
    return await approvalPage(kind, view, token, env);
  }

  const res =
    kind === "approve"
      ? await stub(env).approve(claim.subject, Date.now(), "hugh-link")
      : await stub(env).reject(claim.subject, Date.now());

  if (res.ok !== true) {
    const status = res.error === "illegal_transition" ? 409 : 400;
    return page(
      "Already handled",
      "Already handled",
      p(res.error === "illegal_transition" ? `This job is in state "${res.from}". The link only works once.` : "Nothing to act on."),
      status,
    );
  }

  return kind === "approve"
    ? page("Approved", "Approved", p("The runner picks this up on its next tick and emails the link. Nothing else to do."))
    : page("Rejected", "Rejected", p("The bundle is deleted and the demo URL now returns 404. No email goes out."));
}

// ------------------------------------------------------------------ def re-validation

/**
 * Structural re-validation at publish time. The runner already ran the deep validator;
 * this is the worker-side check that a bundle cannot become servable without passing,
 * whatever happens on the Mac. It is deliberately structural: shapes, bounds, regexes and
 * a charset scan over every string that ends up on screen.
 */
const DISPLAY_LIMITS = {
  robot_name: 48,
  device_line: 72,
  tagline: 80,
  email_summary: 140,
  facts_notes: 2000,
  label: 32,
  unit: 16,
  finding_title: 96,
  first_question: 120,
  suggested: 72,
  answer: 3000,
};

/**
 * Two charsets, and which one a field gets is a security property, not a style one.
 *
 * SINGLE_LINE is the default. Every string below either becomes an email subject, a chart axis
 * label, a chip or a one-line row in Hugh's approval mail, and a newline inside any of those is a
 * header-injection primitive the moment it reaches a mail transport. Only `facts_notes` and
 * `chat.script[].answer` are prose that legitimately wraps, and neither ever reaches a header.
 */
const PRINTABLE_MULTILINE_RE = /^[\x20-\x7E\n]*$/;
const PRINTABLE_SINGLE_LINE_RE = /^[\x20-\x7E]*$/;
const BANNED_DASHES = { "\u2014": "an em dash", "\u2013": "an en dash", "\u2015": "a horizontal bar" };

function scanString(errors, path, value, max, { multiline = false } = {}) {
  if (typeof value !== "string") {
    errors.push({ path, rule: "type", message: `${path} must be a string` });
    return;
  }
  // A display string that is empty or all whitespace renders as a hole in the page and passes
  // every other check, so it is rejected here rather than shipped as a blank chart label.
  if (value.trim().length === 0) {
    errors.push({ path, rule: "minLength", message: `${path} must contain at least one non-whitespace character` });
    return;
  }
  if (value.length > max) {
    errors.push({ path, rule: "maxLength", message: `${path} is ${value.length} chars, max ${max}` });
  }
  for (const ch of value) {
    if (BANNED_DASHES[ch]) {
      errors.push({ path, rule: "charset", message: `${path} contains ${BANNED_DASHES[ch]}, which is banned in display strings` });
      return;
    }
  }
  if (!(multiline ? PRINTABLE_MULTILINE_RE : PRINTABLE_SINGLE_LINE_RE).test(value)) {
    errors.push({
      path,
      rule: "charset",
      message: multiline
        ? `${path} contains characters outside printable ASCII`
        : `${path} contains characters outside printable ASCII, and must be a single line (no newline)`,
    });
  }
}

function walkNumbers(errors, path, value, depth = 0) {
  if (depth > 12) {
    errors.push({ path, rule: "depth", message: `${path} nests deeper than 12 levels` });
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push({ path, rule: "finite", message: `${path} is not a finite number` });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkNumbers(errors, `${path}[${i}]`, v, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkNumbers(errors, `${path}.${k}`, v, depth + 1);
  }
}

function num(errors, path, value, min, max, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, rule: "type", message: `${path} must be a finite number` });
    return;
  }
  if (integer && !Number.isInteger(value)) {
    errors.push({ path, rule: "integer", message: `${path} must be an integer` });
    return;
  }
  if (value < min || value > max) {
    errors.push({ path, rule: "range", message: `${path} is ${value}, must be ${min}..${max}` });
  }
}

function arr(errors, path, value, min, max) {
  if (!Array.isArray(value)) {
    errors.push({ path, rule: "type", message: `${path} must be an array` });
    return false;
  }
  if (value.length < min || value.length > max) {
    errors.push({ path, rule: "length", message: `${path} has ${value.length} entries, must be ${min}..${max}` });
    return false;
  }
  return true;
}

const REQUIRED_TOP = [
  "spec_version", "robot_name", "device_line", "device_id", "tagline", "accent", "seed",
  "duration", "rate", "channels", "data_spec", "scene_spec", "findings", "chat",
  "facts_notes", "email_summary",
];

export function validateDefStructural(def) {
  const errors = [];
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return [{ path: "$", rule: "type", message: "def must be a JSON object" }];
  }
  if (def.refuse === true) {
    return [{ path: "$.refuse", rule: "shape", message: "a refusal is never published" }];
  }

  for (const k of REQUIRED_TOP) {
    if (!(k in def)) errors.push({ path: `$.${k}`, rule: "required", message: `$.${k} is required` });
  }
  if (def.spec_version !== 1) {
    errors.push({ path: "$.spec_version", rule: "const", message: "$.spec_version must be 1" });
  }

  walkNumbers(errors, "$", def);

  scanString(errors, "$.robot_name", def.robot_name, DISPLAY_LIMITS.robot_name);
  scanString(errors, "$.device_line", def.device_line, DISPLAY_LIMITS.device_line);
  scanString(errors, "$.tagline", def.tagline, DISPLAY_LIMITS.tagline);
  scanString(errors, "$.email_summary", def.email_summary, DISPLAY_LIMITS.email_summary);
  scanString(errors, "$.facts_notes", def.facts_notes, DISPLAY_LIMITS.facts_notes, { multiline: true });

  if (typeof def.device_id !== "string" || !DEVICE_ID_RE.test(def.device_id)) {
    errors.push({ path: "$.device_id", rule: "pattern", message: "$.device_id must match ^[a-z0-9][a-z0-9-]{1,22}$" });
  }
  if (typeof def.accent !== "string" || !ACCENT_RE.test(def.accent)) {
    errors.push({ path: "$.accent", rule: "pattern", message: "$.accent must match ^#[0-9a-fA-F]{6}$" });
  }
  num(errors, "$.seed", def.seed, 1, 2147483647, true);
  num(errors, "$.duration", def.duration, 15, 180);
  num(errors, "$.rate", def.rate, 10, 100);

  // channels
  if (arr(errors, "$.channels", def.channels, 1, 6)) {
    const declared = new Set();
    const seenPaths = new Set();
    def.channels.forEach((ch, i) => {
      const at = `$.channels[${i}]`;
      if (!ch || typeof ch !== "object") {
        errors.push({ path: at, rule: "type", message: `${at} must be an object` });
        return;
      }
      if (typeof ch.path !== "string" || !CHANNEL_PATH_RE.test(ch.path)) {
        errors.push({ path: `${at}.path`, rule: "pattern", message: `${at}.path must match ^/[a-z][a-z0-9_]{0,15}$` });
      } else if (seenPaths.has(ch.path)) {
        // Two channels on one path collapse in the mesh-table mapping, so the second one's
        // fields silently disappear from the chart instead of failing loudly.
        errors.push({ path: `${at}.path`, rule: "unique", message: `${at}.path "${ch.path}" is declared twice` });
      } else {
        seenPaths.add(ch.path);
      }
      if (ch.rate !== undefined) num(errors, `${at}.rate`, ch.rate, 1, 100);
      if (arr(errors, `${at}.fields`, ch.fields, 1, 6)) {
        ch.fields.forEach((f, j) => {
          const fat = `${at}.fields[${j}]`;
          if (!f || typeof f !== "object") {
            errors.push({ path: fat, rule: "type", message: `${fat} must be an object` });
            return;
          }
          if (typeof f.key !== "string" || !FIELD_KEY_RE.test(f.key)) {
            errors.push({ path: `${fat}.key`, rule: "pattern", message: `${fat}.key must match ^[a-z][a-z0-9_]{0,15}$` });
          }
          scanString(errors, `${fat}.label`, f.label, DISPLAY_LIMITS.label);
          scanString(errors, `${fat}.unit`, f.unit, DISPLAY_LIMITS.unit);
          if (typeof ch.path === "string" && typeof f.key === "string") declared.add(`${ch.path}.${f.key}`);
        });
      }
    });

    // every declared field needs a data_spec entry, and nothing may be specified twice
    if (!def.data_spec || typeof def.data_spec !== "object" || Array.isArray(def.data_spec)) {
      errors.push({ path: "$.data_spec", rule: "type", message: "$.data_spec must be an object" });
    } else {
      for (const key of declared) {
        if (!(key in def.data_spec)) {
          errors.push({ path: `$.data_spec["${key}"]`, rule: "required", message: `declared field ${key} has no data_spec entry` });
        }
      }
      for (const key of Object.keys(def.data_spec)) {
        if (!declared.has(key)) {
          errors.push({ path: `$.data_spec["${key}"]`, rule: "unknown", message: `data_spec entry ${key} is not a declared channel field` });
        }
      }
    }
  }

  // scene_spec: shape and caps only. Part-ref resolution is the runner validator's job.
  const scene = def.scene_spec;
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    errors.push({ path: "$.scene_spec", rule: "type", message: "$.scene_spec must be an object" });
  } else {
    if (arr(errors, "$.scene_spec.units", scene.units, 1, 6)) {
      scene.units.forEach((u, i) => {
        const at = `$.scene_spec.units[${i}]`;
        if (!u || typeof u !== "object") {
          errors.push({ path: at, rule: "type", message: `${at} must be an object` });
          return;
        }
        if (typeof u.id !== "string" || !FIELD_KEY_RE.test(u.id)) {
          errors.push({ path: `${at}.id`, rule: "pattern", message: `${at}.id must match ^[a-z][a-z0-9_]{0,15}$` });
        }
        if (Array.isArray(u.extra_parts) && u.extra_parts.length > 12) {
          errors.push({ path: `${at}.extra_parts`, rule: "length", message: `${at}.extra_parts has ${u.extra_parts.length} entries, max 12` });
        }
      });
    }
    if (scene.props != null && !arr(errors, "$.scene_spec.props", scene.props, 0, 8)) {
      /* arr() already recorded the reason */
    }
    if (scene.bindings != null && !arr(errors, "$.scene_spec.bindings", scene.bindings, 0, 24)) {
      /* ditto */
    }
  }

  // findings
  const ids = new Set();
  if (arr(errors, "$.findings", def.findings, 2, 5)) {
    def.findings.forEach((f, i) => {
      const at = `$.findings[${i}]`;
      if (!f || typeof f !== "object") {
        errors.push({ path: at, rule: "type", message: `${at} must be an object` });
        return;
      }
      if (typeof f.id !== "string" || !FINDING_ID_RE.test(f.id)) {
        errors.push({ path: `${at}.id`, rule: "pattern", message: `${at}.id must match ^[a-z0-9-]{2,24}$` });
      } else if (ids.has(f.id)) {
        errors.push({ path: `${at}.id`, rule: "unique", message: `${at}.id "${f.id}" is a duplicate` });
      } else {
        ids.add(f.id);
      }
      scanString(errors, `${at}.title`, f.title, DISPLAY_LIMITS.finding_title);
      if (!["alert", "warn", "info"].includes(f.severity)) {
        errors.push({ path: `${at}.severity`, rule: "enum", message: `${at}.severity must be alert, warn or info` });
      }
      // The shape check alone let `["0", null]` through, and a non-numeric window reaches the
      // timeline as a NaN loop that plays nothing. Elements, ordering and bounds, all here.
      if (!Array.isArray(f.window) || f.window.length !== 2) {
        errors.push({ path: `${at}.window`, rule: "shape", message: `${at}.window must be [t0, t1]` });
      } else if (!f.window.every((v) => typeof v === "number" && Number.isFinite(v))) {
        errors.push({ path: `${at}.window`, rule: "type", message: `${at}.window entries must both be finite numbers` });
      } else if (!(f.window[1] > f.window[0])) {
        errors.push({ path: `${at}.window`, rule: "range", message: `${at}.window ends at or before it starts` });
      } else if (typeof def.duration === "number" && (f.window[0] < 0 || f.window[1] > def.duration + 1e-9)) {
        // The same epsilon the runner validator and the loader use, so a window that ends exactly
        // at duration is legal in all three and a def cannot pass one gate and fail another.
        errors.push({ path: `${at}.window`, rule: "range", message: `${at}.window must lie inside [0, ${def.duration}]` });
      }
    });
  }

  // chat
  const chat = def.chat;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) {
    errors.push({ path: "$.chat", rule: "type", message: "$.chat must be an object" });
  } else {
    scanString(errors, "$.chat.first_question", chat.first_question, DISPLAY_LIMITS.first_question);
    if (arr(errors, "$.chat.suggested", chat.suggested, 3, 4)) {
      chat.suggested.forEach((s, i) => scanString(errors, `$.chat.suggested[${i}]`, s, DISPLAY_LIMITS.suggested));
    }
    if (arr(errors, "$.chat.script", chat.script, 4, 6)) {
      chat.script.forEach((e, i) => {
        const at = `$.chat.script[${i}]`;
        if (!e || typeof e !== "object") {
          errors.push({ path: at, rule: "type", message: `${at} must be an object` });
          return;
        }
        if (typeof e.id !== "string" || !FINDING_ID_RE.test(e.id)) {
          errors.push({ path: `${at}.id`, rule: "pattern", message: `${at}.id must match ^[a-z0-9-]{2,24}$` });
        }
        scanString(errors, `${at}.answer`, e.answer, DISPLAY_LIMITS.answer, { multiline: true });
        if (arr(errors, `${at}.matchers`, e.matchers, 1, 16)) {
          e.matchers.forEach((m, j) => scanString(errors, `${at}.matchers[${j}]`, m, 48));
        }
        // An evidence id nothing declares is a chip that fires nothing, which reads to the
        // visitor as a broken demo rather than a missing one.
        if (e.evidence != null) {
          if (!Array.isArray(e.evidence)) {
            errors.push({ path: `${at}.evidence`, rule: "type", message: `${at}.evidence must be an array of finding ids` });
          } else {
            e.evidence.forEach((id, j) => {
              if (!ids.has(id)) {
                errors.push({ path: `${at}.evidence[${j}]`, rule: "reference", message: `${at}.evidence[${j}] cites finding ${JSON.stringify(id)}, which is not declared` });
              }
            });
          }
        }
      });
    }
  }

  return errors;
}

// ------------------------------------------------------------------ runner routes

function bearerOk(request, env) {
  const want = env.DEMOGEN_TOKEN;
  if (!want) return false;
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(got, String(want));
}

async function readJsonBody(request, maxBytes) {
  const raw = await request.text();
  if (enc.encode(raw).byteLength > maxBytes) return { tooLarge: true };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { bad: true };
  }
}

async function handleRunner(request, env, url, tail) {
  if (!bearerOk(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const do_ = stub(env);

  if (tail === "queue" && request.method === "GET") {
    return json(await do_.queue(Date.now()));
  }

  if (tail === "review" && request.method === "GET") {
    const res = await do_.review(Date.now());
    const origin = originOf(env);
    const jobs = [];
    for (const j of res.jobs) {
      jobs.push({
        ...j,
        demo_url: `${origin}/demo/#/connect/g-${j.slug}`,
        ...(await approvalLinks(env, j.id, j.slug)),
        unsub_token: await makeToken(env, "unsub", j.email, 0),
      });
    }
    return json({ jobs });
  }

  if (tail === "claim" && request.method === "POST") {
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const runner = body.value?.runner ?? null;
    const res = await do_.claim(runner, Date.now(), env.DEMOGEN_MAX_JOBS_PER_DAY ?? 8);
    if (!res.job) {
      // 204 either way: to the runner "nothing claimable" and "capped for today" are the
      // same instruction. The reason header is there so the tick log can tell them apart.
      return new Response(null, { status: 204, headers: { ...NO_STORE, "x-demogen-reason": res.reason || "empty" } });
    }
    const origin = originOf(env);
    return json({
      job: {
        ...res.job,
        unsub_token: await makeToken(env, "unsub", res.job.email, 0),
        demo_url: `${origin}/demo/#/connect/g-${res.job.slug}`,
        // Signed here, used verbatim by the runner's approval mail. The runner never holds the
        // signing key and never builds one of these itself.
        ...(await approvalLinks(env, res.job.id, res.job.slug)),
      },
      claim_token: res.claim_token,
    });
  }

  if (tail === "publish" && request.method === "POST") {
    const body = await readJsonBody(request, MAX_DEF_BYTES + MAX_FACTS_BYTES + 8192);
    if (body.tooLarge) return json({ ok: false, error: "body_too_large" }, 413);
    if (body.bad || !body.value) return json({ ok: false, error: "bad_json" }, 400);
    const b = body.value;

    if (typeof b.job_id !== "string" || typeof b.claim_token !== "string") {
      return json({ ok: false, error: "job_id and claim_token are required" }, 400);
    }

    // The runner's api.mjs sends the parsed object as `def`; the plan's contract is the
    // string `def_json`. Accept both, normalize to the string, and re-parse it here so the
    // bytes we store are exactly the bytes we validated.
    let defJson;
    if (typeof b.def_json === "string") defJson = b.def_json;
    else if (b.def && typeof b.def === "object") defJson = JSON.stringify(b.def);
    else return json({ ok: false, error: "def_json (string) or def (object) is required" }, 400);

    const defBytes = enc.encode(defJson).byteLength;
    if (defBytes > MAX_DEF_BYTES) return json({ ok: false, error: `def_json is ${defBytes} bytes, max ${MAX_DEF_BYTES}` }, 413);

    let factsJson = null;
    if (b.facts_json != null) {
      factsJson = typeof b.facts_json === "string" ? b.facts_json : JSON.stringify(b.facts_json);
      const factsBytes = enc.encode(factsJson).byteLength;
      if (factsBytes > MAX_FACTS_BYTES) return json({ ok: false, error: `facts_json is ${factsBytes} bytes, max ${MAX_FACTS_BYTES}` }, 413);
      try {
        JSON.parse(factsJson);
      } catch {
        return json({ ok: false, error: "facts_json is not valid JSON" }, 422);
      }
    }

    let def;
    try {
      def = JSON.parse(defJson);
    } catch {
      return json({ ok: false, error: "def_json is not valid JSON" }, 422);
    }

    const errors = validateDefStructural(def);
    if (errors.length > 0) {
      return json({ ok: false, error: "def failed structural re-validation", errors: errors.slice(0, 20) }, 422);
    }

    const res = await do_.publish({
      jobId: b.job_id,
      claimToken: b.claim_token,
      defJson,
      factsJson,
      robotName: b.robot_name ?? def.robot_name,
      deviceId: b.device_id ?? def.device_id,
      emailSummary: b.email_summary ?? def.email_summary,
      bytes: defBytes,
      sha256: await sha256Hex(defJson),
      now: Date.now(),
    });
    if (res.ok !== true) return json(res, res.error === "illegal_transition" ? 409 : 400);
    return json({ ...res, slug: res.slug, demo_url: `${originOf(env)}/demo/#/connect/g-${res.slug}` });
  }

  if (tail === "status" && request.method === "POST") {
    const body = await readJsonBody(request, MAX_BODY_BYTES * 4);
    if (body.tooLarge) return json({ ok: false, error: "body_too_large" }, 413);
    if (body.bad || !body.value) return json({ ok: false, error: "bad_json" }, 400);
    const b = body.value;
    if (typeof b.job_id !== "string" || typeof b.state !== "string") {
      return json({ ok: false, error: "job_id and state are required" }, 400);
    }
    const res = await do_.status({
      jobId: b.job_id,
      claimToken: b.claim_token ?? null,
      state: b.state,
      // `detail` is what the runner's api.mjs calls it; `error` is the plan's name.
      error: b.error ?? b.detail ?? null,
      messageId: b.message_id ?? null,
      attempts: b.attempts ?? null,
      now: Date.now(),
    });
    if (res.ok !== true) return json(res, res.error === "illegal_transition" ? 409 : 400);
    return json(res);
  }

  // Bearer-gated introspection, additionally gated on DEMOGEN_DEBUG=1 which production
  // never sets: a leaked bearer must not enumerate leads or the suppression list.
  if (tail === "debug" && request.method === "GET") {
    if (env.DEMOGEN_DEBUG !== "1") return json({ error: "Not found." }, 404);
    // Presence booleans only. A missing secret is the single most likely cause of a silent
    // funnel, and it is not diagnosable from the outside any other way.
    const config = {
      signing_key: Boolean(env.DEMOGEN_SIGNING_KEY),
      resend_key: Boolean(env.DEMOGEN_RESEND_KEY),
      dev_no_email: env.DEMOGEN_DEV_NO_EMAIL === "1",
      from: env.DEMOGEN_FROM || FALLBACK_FROM,
      origin: originOf(env),
      max_jobs_per_day: Number(env.DEMOGEN_MAX_JOBS_PER_DAY ?? 8),
    };
    return json({ config, ...(await do_.debug(url.searchParams.get("job_id") || null)) });
  }

  return json({ ok: false, error: "not found" }, 404);
}

// ------------------------------------------------------------------ entry point

export default async function handleDemoGen(request, env, ctx, url) {
  try {
    const path = url.pathname;

    if (path.startsWith("/demo/js/robots/g-")) {
      if (request.method !== "GET" && request.method !== "HEAD") return textResponse("method not allowed", 405);
      const rest = path.slice("/demo/js/robots/g-".length);
      const slash = rest.indexOf("/");
      const slug = slash < 0 ? rest : rest.slice(0, slash);
      const file = slash < 0 ? "" : rest.slice(slash);
      return await handleDefJson(request, env, ctx, url, slug, file);
    }

    if (path.startsWith("/api/demo-gen/runner/")) {
      return await handleRunner(request, env, url, path.slice("/api/demo-gen/runner/".length));
    }

    if (path === "/api/demo-gen/submit") {
      if (request.method !== "POST") return json({ ok: false, reason: "invalid" }, 405);
      return await handleSubmit(request, env, ctx);
    }
    if (path === "/api/demo-gen/verify") {
      // GET renders the confirm page, POST commits. See confirmPage().
      if (request.method !== "GET" && request.method !== "POST") return textResponse("method not allowed", 405);
      return await handleVerify(request, env, url);
    }
    if (path === "/api/demo-gen/unsubscribe") {
      if (request.method !== "GET" && request.method !== "POST") return textResponse("method not allowed", 405);
      return await handleUnsubscribe(request, env, url);
    }
    if (path === "/api/demo-gen/approve" || path === "/api/demo-gen/reject") {
      if (request.method !== "GET" && request.method !== "POST") return textResponse("method not allowed", 405);
      return await handleApproval(request, env, url, path.endsWith("approve") ? "approve" : "reject");
    }

    return json({ ok: false, error: "not found" }, 404);
  } catch (err) {
    console.log(`[demo-gen] ${request.method} ${url.pathname} threw: ${String(err?.stack ?? err)}`);
    return json({ ok: false, error: "server error" }, 500);
  }
}
