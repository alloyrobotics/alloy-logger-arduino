# demo-gen curl matrix

Manual acceptance matrix for `worker/demo-gen.js` + `worker/do.js` against `wrangler dev`.
Every line below was run on 2026-07-27 from the repo root; the responses are the observed
ones, not expected ones. Re-run this after any change to either file.

The rows marked **(2026-07-27 pass 2)** were re-run after the fresh-eyes review fixes, on a
second `wrangler dev` on port 8788 with its own `--persist-to` directory. The captured
responses from that run are also what `~/.local/bin/alloylogger-demo-runner/fixtures/api/*.json`
now contains, byte for byte: the runner's offline transport replays real worker output rather
than a hand-written guess at it.

**(2026-07-28, shelve.)** The generator's ENTRY is closed and its serving path is not. `submit` is
a `410` tombstone, `verify` renders a paused page and transitions nothing, and two runner routes
were added for the shutdown: read-only `GET runner/state` and the flag-gated `POST
runner/shelf-purge`. Everything that serves an already-published demo (def.json for a `g-` slug,
`/demo/api/chat`, approve, reject, unsubscribe, claim, publish, status, review) is unchanged and
still live. The rows below are marked where the shelve changed the observed answer; the historical
rows are kept, because un-shelving is reverting the tombstones and this is the matrix that then
has to pass again.

**(2026-07-28, signup leads.)** The demo's signup popup captures an email now, so the site Worker
has one new pair of routes in `worker/signup-lead.js`: public `POST /api/signup-lead` and
bearer-gated `GET /api/signup-lead/list`. They share the DO (a new `leads` table, two new methods)
and the `DEMOGEN_TOKEN` bearer, and nothing else: no job row, no state machine, no signed link. See
"Signup lead capture" below.

**(2026-07-28, signup-lead hardening.)** A security pass over that pair changed four things, all of
them ceilings and all of them documented in the matrix below:

- the 8 KB body cap is enforced on the STREAM, not after `request.text()`. A chunked post carries
  no `Content-Length`, so the old order buffered the whole body and only then measured it; the read
  now cancels the moment the running total would cross 8 KB.
- two new edge rate limiters, `LEAD_RL_IP` (5/60s per `CF-Connecting-IP`) and `LEAD_RL_ALL`
  (60/60s, keyless), run before the body is read and before the DO is touched. Missing bindings are
  a `503`, exactly as `chat.js` reads them.
- a GLOBAL cap of 500 NEW leads per UTC day (`DEMOGEN_LEAD_DAILY_CAP`), and a budget of 25
  notification emails per UTC day. Past the lead cap: no row, no mail. Past the notify budget: the
  lead is STILL STORED and only the mail is skipped.
- `GET /api/signup-lead/list` pages. The response is an object now, not a bare array, and it hands
  back a `next_before` cursor when it truncated.

There is no full automated test runner for the site Worker (the repo has no test harness outside
`cloud/`), so this file is the contract for everything that needs a live `wrangler dev`. The parts
that do NOT need one are executable and must stay green:

```sh
node --test worker/demo-gen.unit.test.mjs     # 43 tests, no network, no wrangler
```

`worker/demo-gen.unit.test.mjs` drives `handleDemoGen()` and `handleSignupLead()` directly under
Node. It owns the assertions a curl matrix cannot make: the submit tombstone driven with a request
whose `text()`, DO getter, `ctx.waitUntil` and `fetch` all throw if touched (that is how "zero side
effects" is proved rather than eyeballed), the paused verify asserted against a DO stub that WOULD
have moved the row, the two shelve-era runner routes' auth, exact field contract, read-only-ness,
purge scope, refusals and idempotence, and (2026-07-28) the whole of the lead capture: dedupe,
per-IP cap, honeypot, the 400s, the export, and a `fetch` stub that FAILS the test if a silent-drop
path so much as attempts a Resend call. It reads the state enum, the review states and the schema
out of `worker/do.js` itself, so it fails if the machine's shape drifts from what it asserts, and
the lead SQL under test is the real `do-shelve.js` code the DO calls, not a restatement of it.

The hardening pass added seven more, and each one is a claim a curl matrix cannot make:

| test | what only the unit test can prove |
| --- | --- |
| chunked oversize | a 64 KB body with NO `Content-Length`, fed 1 KB at a time from a real `ReadableStream`, is refused after roughly 8 chunks with the reader CANCELLED, against an env whose DO getter throws. "Never buffered and never reached the DO" is then a fact about the code path, not an absence in a log |
| limiters fail closed | four shapes of missing/partial/malformed `LEAD_RL_*` binding, each a `503` that never reaches the DO, plus `DEV=1` running open and both limiters being consulted with the right keys when present |
| over-limit is silent | the per-IP limiter and the global limiter each dropping on their own, with the other wide open, so the answer is a `202` with no DO call, no row and no scheduled work. Also that a limiter which THROWS runs open, because a Cloudflare blip must not cost a lead |
| global daily cap | 500 leads from 500 distinct IPs, then a 501st from a fresh IP well under the per-IP cap. Only the global ceiling can stop it, and it does: no row, no mail, a `202` |
| cap override | `DEMOGEN_LEAD_DAILY_CAP=2` caps at two, and `=0` pauses the capture entirely rather than silently restoring 500 |
| notify budget | 25 leads, 25 recorded Resend calls, then a 26th that is STORED, appears in the export, and never touches `fetch`. The budget cannot cost a lead, only a mail |
| list cursor | a `?before=` walk over real rows, a `bad_cursor` 400, and a stubbed 5000-row DO proving the Worker asks for 1001, returns 1000, and names the OLDEST returned row as `next_before` |

## Running it

The three secrets are never in a file. Local dev passes them as `--var`, which lands in the
same `env` slots a deployed secret would:

```sh
npx wrangler dev --port 8787 --ip 127.0.0.1 \
  --var DEV:1 \
  --var DEMOGEN_TOKEN:dev-runner-token-12345 \
  --var DEMOGEN_SIGNING_KEY:dev-signing-key-0123456789abcdef \
  --var DEMOGEN_ORIGIN:http://127.0.0.1:8787 \
  --var DEMOGEN_DEV_NO_EMAIL:1
```

**A SECOND instance needs its own state directory, not just its own port.** Two `wrangler dev`
processes in this repo share `.wrangler/state`, and the DO's sqlite file is not shareable: the
newcomer dies on startup with `Fatal uncaught kj::Exception ... SENTRY_DO SQLite failed;
database is locked: SQLITE_BUSY_RECOVERY`, which reads like a workerd bug and is not one. Add
`--persist-to` and both live happily, with independent job tables:

```sh
npx wrangler dev --port 8788 --ip 127.0.0.1 --persist-to /tmp/wstate8788 \
  --var DEV:1 --var DEMOGEN_TOKEN:dev-runner-token-12345 \
  --var DEMOGEN_SIGNING_KEY:dev-signing-key-0123456789abcdef \
  --var DEMOGEN_ORIGIN:http://127.0.0.1:8788 \
  --var DEMOGEN_DEV_NO_EMAIL:1 --var DEMOGEN_DEBUG:1
```

- `DEMOGEN_ORIGIN` makes every generated link point at localhost. Production leaves it
  unset and the code falls back to `https://alloylogger.com`.
- `DEMOGEN_DEV_NO_EMAIL:1` gated the verification mail on the submit path, and that path is a 410
  tombstone with no mail code behind it, so it is inert for `demo-gen.js`. It is LIVE again for
  `worker/signup-lead.js`, whose lead notification honours the same guard, and it should be set on
  every local run. See "Email in dev" below.
- `DEMOGEN_LEASE_MS` (Phase B only) shortens the 30 minute claim lease so the reclaim path
  is testable in seconds. Never set it in production.
- `DEMOGEN_MAX_JOBS_PER_DAY` overrides the `vars` default of 8. **(2026-07-27 pass 2)** `0` now
  means zero: the DO parses it with `Number.isFinite` instead of `Number(x) || 8`, so setting it
  to `0` pauses the funnel instead of silently restoring the default cap.
- **(2026-07-28 hardening)** `DEMOGEN_LEAD_DAILY_CAP` overrides the 500/UTC-day global new-lead
  cap in `signup-lead.js`, parsed the same way and with the same reading of `0`: a deliberate pause
  of the capture, not a typo that restores 500. Set it to something small (`--var
  DEMOGEN_LEAD_DAILY_CAP:2`) to drive the cap row in the matrix below without posting 501 leads.

**The `ratelimits` bindings DO work in `wrangler dev`, and this was verified, not assumed.**
Starting the command above prints them in the bindings table and enforces them in local mode:

```
env.CHAT_RL_IP (12 requests/60s)     Rate Limit   local
env.CHAT_RL_ALL (150 requests/60s)   Rate Limit   local
env.LEAD_RL_IP (5 requests/60s)      Rate Limit   local
env.LEAD_RL_ALL (60 requests/60s)    Rate Limit   local
```

Seven POSTs from one `cf-connecting-ip` on 2026-07-28 gave five `202`s that stored a row and two
that logged `[signup-lead] rl-drop ip`, so the limiter really counts locally rather than being a
no-op stub. **No extra `--var` or binding flag is needed for them.**

`DEV:1` is therefore a FALLBACK, not the thing that makes local dev work, and the distinction
matters: it satisfies the "are the limiters configured" gate, so a wrangler version that ever
stopped binding them would still run locally, and it does NOT stop a bound limiter from counting.
`.dev.vars` sets it already, so the `--var DEV:1` in the commands above is belt and braces rather
than a requirement. To exercise the wall, post faster than 5/60s from one `cf-connecting-ip`; to
see what `DEV:1` is actually for, run against a config with the `ratelimits` block removed, where
it is the difference between a working local Worker and a `503` on every capture.

Two helpers used below live in the session scratchpad, not the repo:

- `tok.mjs <purpose> <subject> [ttlMs]` mints the same HMAC link tokens the Worker does, so
  verify / approve / reject / unsubscribe can be driven without scraping a log. It is 6
  lines of `node:crypto` over `DEMOGEN_SIGNING_KEY`.
- `pub.mjs <job_id> <claim_token> [--emdash|--specver|--deviceid]` builds a publish body
  from the runner's hand-written fixture
  `~/.local/bin/alloylogger-demo-runner/fixtures/minimal-rover.def.json`, optionally
  corrupting one field.

`GET /api/demo-gen/runner/debug` (bearer gated) dumps job rows, event counters, the
suppression list and a secrets-presence block. It is the only way to assert "no job row was
created", which several cases below need.

## Phase A: default lease

### Existing routes still work

| curl | observed |
| --- | --- |
| `curl -i localhost:8787/` | `200`, 181769 bytes of the landing page |
| `curl -i localhost:8787/demo/` | `200`, 30005 bytes |
| `curl -X POST localhost:8787/demo/api/chat -H 'content-type: application/json' -d '{}'` | `503` from chat.js failing closed without an API key, so the delegation still runs before the assets fallthrough |
| `curl localhost:8787/api/demo-gen/nope` | `404 {"ok":false,"error":"not found"}` |

The `site-worker.js` diff is additive: one import, one `export { DemoGenDO }`, a `ctx`
parameter and one `if` block before `env.ASSETS.fetch`. The www redirect and the
`/demo/api/chat` branch are byte-identical.

### POST /api/demo-gen/submit: SHELVED, a 410 tombstone

**(2026-07-28.)** The entry is closed. `handleSubmit()` takes no arguments and returns one
response, and the route is the FIRST branch in `handleDemoGen()`, so the tombstone is reached
before anything can read a body, resolve the DO or schedule background work.

```sh
UC='2v2 RoboCup open-league soccer sim, 4 agents on ROS 2, we keep losing the ball on defensive clears'
curl -i -X POST localhost:8787/api/demo-gen/submit -H 'content-type: application/json' \
  -H 'CF-Connecting-IP: 198.51.100.1' \
  -d "{\"email\":\"lead1@example.com\",\"use_case\":\"$UC\",\"dwell_ms\":9000,\"robot_seen\":\"sbr\",\"website\":\"\"}"
```

| case | body sent | observed | job row |
| --- | --- | --- | --- |
| former happy path | above | `410 {"ok":false,"reason":"gone","error":"demo generation is paused"}` | none |
| malformed JSON | `{oops` | `410`, same body | none |
| wrong content-type | `content-type: text/plain` | `410`, same body | none |
| body over 4KB | 6000 char use_case | `410`, same body, body never read | none |
| honeypot / short dwell | `"website":"http://spam"` / `"dwell_ms":400` | `410`, same body | none, and NO `honeypot` or `dwell_block` event either |
| GET, PUT, DELETE instead of POST | | `410`, same body (no 405: the resource is gone for every verb) | none |

Every response carries `Cache-Control: no-store` and no CORS headers.

Assert the side-effect absence, not just the status. Before and after the whole block above,
`GET /api/demo-gen/runner/debug` must show the same job rows, the same event counters (no
`submit`, `honeypot`, `dwell_block`, `rate_block_*`, `submit_dedupe`, and no mail counter of any
kind) and the same suppression list. The executable version of this is in
`worker/demo-gen.unit.test.mjs`, which drives the handler with a request that throws from
`text()`, `json()` and `body`, an `env` that throws on every property access, a `ctx.waitUntil`
that throws and a `fetch` that throws.

Zero Resend sends by construction: the Worker has no code that calls a mail provider at all any
more. The function that did, and the `verify_mail_sent` / `verify_mail_failed` counters it wrote,
were deleted with the submit path. Git history is the record if the entry is ever reopened.

### Rate windows, dedupe, suppression: HISTORICAL

**(2026-07-28.)** Unreachable while `submit` is shelved, because nothing creates a job row any
more. `DemoGenDO.submit()` still implements all of it and none of it was changed, so these rows are
what must pass again if the entry is ever reopened.

Four submits from `CF-Connecting-IP: 203.0.113.77`, four different emails and use cases:

| submit | observed (2026-07-27, pre-shelve) |
| --- | --- |
| 1, 2, 3 | `202 {"ok":true}` |
| 4 | `429 {"ok":false,"reason":"rate"}`, event `rate_block_ip` |

| case | observed (2026-07-27, pre-shelve) |
| --- | --- |
| resubmit an identical (email, use_case) pair from a different IP | `202 {"ok":true,"duplicate":true}`, event `submit_dedupe`, no second job row |
| third submit for the same email inside 24h (different use case, fresh IP) | `429 {"ok":false,"reason":"rate"}`, event `rate_block_email` |
| submit from a suppressed address | `202 {"ok":true}`, event `submit_suppressed`, no job row |

The dedupe hit still writes `submit_ip:` and `submit_email:` events, so repeating the same
submission cannot be used to probe the dedupe window for free.

`ip_hash` was `sha256(CF-Connecting-IP + DEMOGEN_SIGNING_KEY)` truncated to 32 hex chars. The
raw IP is never passed to the DO and never stored.

### GET|POST /api/demo-gen/verify: PAUSED, one page, no transition

**(2026-07-28.)** `handleVerify()` takes no arguments. It does not read the token, does not call
the DO and renders the same page for both verbs. That is the only way to be certain no state
moves: a verification link that still confirmed would move a job `unverified -> pending` and tell
the visitor a build had started, which is a promise nothing keeps while the runner is off.

Verification links have a 7 day TTL, so real ones are in real inboxes right now. They land on an
honest page instead of a lie.

```sh
T=$(node tok.mjs verify <job_id>)
curl -i "localhost:8787/api/demo-gen/verify?t=$T"
```

| case | observed |
| --- | --- |
| `GET /verify?t=<valid>` | `200`, page headed "Demo generation is paused". No form and no script on the page. Job row **unchanged** (assert via `runner/debug` before and after) |
| `POST /verify?t=<valid>` | `200`, same page. Job row **unchanged**: no `unverified -> pending` |
| `GET|POST /verify` with a junk, expired, or wrong-purpose token | `200`, same page. Nothing distinguishes them any more, because nothing reads the token |
| `PUT /verify?t=` | `405 method not allowed` (the route's shape is deliberately unchanged) |

Every response carries `Cache-Control: no-store`. The page carries no em dash, en dash or
horizontal bar, asserted in `worker/demo-gen.unit.test.mjs`.

The historical behaviour, for un-shelving: verify was a GET/POST pair, like approve and reject.
The GET only rendered; the POST committed. A mail provider or chat client that prefetches the link
"clicks" the GET before the human does, and a scanner-confirmed address is a lead we would build a
demo for that nobody asked to confirm. The rendered page auto-submitted its own form via a
four-word inline script, so a real browser confirmed in one frame and the visitor saw only the
result, while a scanner that does not run JS committed nothing. The visible button was the no-JS
path. Unsubscribe still works exactly that way and is UNCHANGED.

| historical case (2026-07-27) | observed then |
| --- | --- |
| `GET /verify?t=` | `200`, "One tap to confirm", POST form plus auto-submit script, row still `unverified` |
| `POST /verify?t=` | `200`, "You're confirmed", job goes `unverified` to `pending` |
| second POST with the same token | `200`, "Already confirmed", state unchanged |
| token with two characters appended | `400`, "That link is not valid" |
| a valid `approve` token replayed on `/verify` | `400`, "That link is not valid" (the purpose is inside the HMAC) |
| a correctly signed token whose expiry is in the past | `400`, "That link is not valid" |

Expiry is inside the signed payload, so it cannot be edited without the key. `expiry: 0`
means no expiry and is only ever minted for `unsub`, where a link that stops working would
be a compliance problem.

### GET /api/demo-gen/unsubscribe

| case | observed |
| --- | --- |
| `GET` with a valid token **(pass 2)** | `200`, "Take me off the list", POST form plus auto-submit script. `suppression` still `[]` after the GET |
| `POST` with a valid token (purpose `unsub`, subject is the email, no expiry) | `200`, "You won't hear from us again", row in `suppression` |
| `?t=zzzz` | `400`, "That link is not valid" |

### Runner routes

All under `/api/demo-gen/runner/`, all `Authorization: Bearer $DEMOGEN_TOKEN` with a
constant-time compare.

| case | observed |
| --- | --- |
| no `Authorization` header | `401 {"ok":false,"error":"unauthorized"}` |
| `Bearer nope` | `401 {"ok":false,"error":"unauthorized"}` |
| `GET queue` with the right bearer | `200 {"open":4,"claimable":1,"approved_unsent":0,"pending":1,"oldest_age_s":0,"claimed_today":0}` |

#### GET runner/state (new 2026-07-28): the drain gate

Read-only visibility for the shelve shutdown, which polls it until the queue is empty. One count
per state in the DO's FULL enum (`LEGAL_TRANSITIONS` in `do.js` is normative), plus `unknown`,
`review_total` and `next_claim_expiry_s`. Nothing else, and deliberately no derived "undelivered
and ready" field: `delivery_failed` does not record which mail kind failed (that lives only in the
runner's marker files), so the gate reads the counts directly and investigates `delivery_failed`
on the Mac.

The field set is fixed by the enum and never by the data. A job row whose `state` is not in the
enum (a legacy value from an older schema, or a corrupt write) is counted under `unknown` rather
than under a key named after itself: dropping it would let the drain gate read zero while work was
still queued, and naming a key after it would let a database row invent a field in a contract that
is machine-read below. `unknown > 0` means go and look at the table by hand; it is not a state the
runner can drain.

```sh
curl -s -H "Authorization: Bearer $DEMOGEN_TOKEN" localhost:8788/api/demo-gen/runner/state
```

```json
{"unverified":2,"pending":1,"claimed":0,"generated":1,"approved":1,"refused":0,"error":0,
 "expired":0,"delivery_failed":1,"emailed":1,"rejected":0,"unknown":0,
 "review_total":3,"next_claim_expiry_s":null}
```

| case | observed |
| --- | --- |
| no `Authorization`, `Bearer nope`, or the token plus one character | `401 {"ok":false,"error":"unauthorized"}` |
| right bearer | `200`, `Cache-Control: no-store`, exactly the field set above |
| response content | counts only. No email, no use case, no slug, no job id, no claim token. A leaked bearer buys the size of the queue and nothing about the people in it |
| with one claimed job, lease 2 min out | `next_claim_expiry_s` counts down toward it; with two claims it reports the EARLIEST |
| with no claimed job at all | `next_claim_expiry_s: null`, not `0` |
| with a claimed job whose lease has ALREADY expired | `claimed` still 1, `pending` still 0, `next_claim_expiry_s: 0`. **Observing an expired lease must not reclaim it**, and no `runner_seen` event is written: `queue` and `review` both do those things, this route does neither, because a gate that mutates what it measures is not a gate |
| `POST runner/state` | `404` (GET only) |
| a job row seeded with a state outside the enum | counted in `unknown`, field set otherwise unchanged: no key is named after the offending value. Covered by `worker/demo-gen.unit.test.mjs`, which writes the illegal value straight into sqlite because `transition()` would refuse it |

The drain is complete when `pending`, `claimed`, `generated`, `approved`, `delivery_failed` and
`review_total` are all `0`. `unverified` is drained by the purge below, not by ticks. `unknown`
must also be `0`; it is not drainable by a tick, so anything there is a manual look at the table.

#### POST runner/shelf-purge (new 2026-07-28): flag-gated, one-time

Exists ONLY while `DEMOGEN_SHELF_PURGE=1` is set on the deploy (`wrangler deploy --var
DEMOGEN_SHELF_PURGE:1`, never in `wrangler.jsonc`), and is removed by redeploying without it. That
is the whole reason it is safe: this Worker carries no standing bulk-delete surface.

Scope: every `unverified` row always, plus `pending` and `delivery_failed` jobs whose slug is in
the request's allowlist and nothing else. The allowlist is the executable disposition for the two
otherwise-undrainable cases, since the machine has no `pending -> rejected` edge and
`delivery_failed` can only ever go to `emailed`. Each slug is a per-job call of Hugh's.

```sh
curl -s -X POST -H "Authorization: Bearer $DEMOGEN_TOKEN" -H 'content-type: application/json' \
  -d '{"allow_slugs":["lvcvdgyf42x7i5eqrkwu"]}' \
  localhost:8788/api/demo-gen/runner/shelf-purge
```

```json
{"ok":true,"unverified_deleted":2,"allowlisted_deleted":1,"bundles_deleted":1,
 "deleted":[{"slug":"...","state":"unverified"},{"slug":"lvcvdgyf42x7i5eqrkwu","state":"pending"}],
 "refused":[],"not_found":[]}
```

| case | observed |
| --- | --- |
| flag unset, or set to anything but `1` | `404`, and the DO is never called |
| no bearer / wrong bearer, flag set | `401 {"ok":false,"error":"unauthorized"}` |
| `GET` with the flag set | `404`: POST only |
| `allow_slugs` not an array, an entry failing `^[a-z2-7]{20}$`, or more than 100 entries | `400`, nothing deleted |
| no body, or a body that is not a JSON object | `400 {"ok":false,"error":"bad_json"}` |
| `{}` or `{"allow_slugs":[]}` | purges `unverified` rows only |
| an allowlisted slug in `approved` (or any state but `pending`/`delivery_failed`) | refused by name in `refused: [{slug, state}]`, and that job is untouched |
| an allowlisted slug the DO does not know, or already purged | listed in `not_found`, not an error |
| running it twice with the same body | idempotent: second call returns all-zero counts, `deleted: []`, and the slugs under `not_found` |
| what survives | every job row not in scope, every bundle whose job survives, every suppression row, and the whole append-only `events` table. One `shelf_purge` event is added |
| the bundle of a job that IS deleted | deleted with it, exactly as `reject()` does it. `bundle()` resolves a slug through the jobs table first, so it could never be served again anyway, and leaving it keeps the visitor's own description on disk with nothing pointing at it |

Logged server-side as one line: counts plus the slugs deleted, refused and not found. Slugs only,
never the addresses that went with them.

Post-shelve check, after redeploying WITHOUT the flag: the same POST returns `404`.

`POST claim` **(2026-07-27 pass 2, captured verbatim as the runner's `fixtures/api/claim.json`)**:

```json
{"job":{"id":"3vooh4xcnk4b544nsypgx2","slug":"imfu5hyadf56qu2swb25","email":"visitor@example.com",
        "use_case":"Cold store AMR fleet run 2, ...","robot_seen":"sbr",
        "created_at":"2026-07-27T12:22:23.091Z","attempts":[],
        "claim_token":"898fd1dcfed31983847d9b3b03f66dd6a56de1ebb835c987",
        "lease_until":"2026-07-27T12:52:23.099Z","runner":"alloylogger-demo-runner/1",
        "unsub_token":"dmlzaXRvckBleGFt...",
        "demo_url":"http://127.0.0.1:8788/demo/#/connect/g-imfu5hyadf56qu2swb25",
        "approve_url":"http://127.0.0.1:8788/api/demo-gen/approve?t=M3Zvb2g0eGNu...",
        "reject_url":"http://127.0.0.1:8788/api/demo-gen/reject?t=M3Zvb2g0eGNu...",
        "preview_url":"http://127.0.0.1:8788/demo/?preview=M3Zvb2g0eGNu...#/connect/g-imfu5hyadf56qu2swb25"},
 "claim_token":"898fd1dcfed31983847d9b3b03f66dd6a56de1ebb835c987"}
```

**The three approval links are part of the claim contract now, and of the review contract.** They
used to appear only on `review`, and the runner built its own out of `approve_token` /
`reject_token` fields that the claim response has never carried, so every approval mail went out
with `(missing)` where the links belong. The Worker owns the signing key, so the Worker mints
them; the runner uses the strings verbatim and cannot construct one. `preview_url` puts
`?preview=` BEFORE the `#`, because everything after the hash goes to the demo app's router and
`generated.js` reads the token out of `location.search`.

A second `POST claim` with nothing pending returns `204` and `X-DemoGen-Reason: empty`.

`POST claim` also retires a poison job before handing anything back **(pass 2)**:

| step | observed |
| --- | --- |
| `status` a claimed job to `pending` with `attempts: 3` | `200 {"ok":true,"state":"pending"}` |
| `POST claim` with that job at the head of the queue | `204`, and the job row is now `state=error`, `error=attempts_exhausted` |

`pending -> error` is a new legal edge for exactly this. The runner refuses to generate a job at
the attempt cap too; this is the server-side half, so an older or misconfigured runner cannot
re-claim the same failing job every five minutes forever.

`POST publish` re-validates the def worker-side before anything becomes servable:

| case | observed |
| --- | --- |
| `--emdash` (em dash injected into `robot_name`) | `422 {"errors":[{"path":"$.robot_name","rule":"charset","message":"$.robot_name contains an em dash, which is banned in display strings"}]}` |
| `--specver` (`spec_version: 2`) | `422 ... {"path":"$.spec_version","rule":"const","message":"$.spec_version must be 1"}` |
| `--deviceid` (`device_id: "Bad_Device_ID"`) | `422 ... {"path":"$.device_id","rule":"pattern","message":"$.device_id must match ^[a-z0-9][a-z0-9-]{1,22}$"}` |

Five re-check gaps closed **(2026-07-27 pass 2)**. Each one was a def the deep validator rejects
and the Worker happily published, which is the wrong way round for a backstop:

| rule | what it now rejects |
| --- | --- |
| `unique` on `$.channels[i].path` | two channels on one path. They collapse in the mesh-table mapping, so the second one's fields vanish from the chart instead of failing |
| `range` on `$.channels[i].rate` | a per-channel rate override outside 1..100 Hz |
| `reference` on `$.chat.script[i].evidence[j]` | an evidence id no finding declares, which renders as a chip that fires nothing |
| `type` / `range` on `$.findings[i].window` | `["0", null]`, a window that ends before it starts, or one outside `[0, duration + 1e-9]`. The epsilon is the same in the validator, here and in the loader, so a window ending exactly at `duration` is legal in all three |
| `minLength` and single-line `charset` on every display string | an empty or all-whitespace label, and a newline in anything that reaches an email subject. Only `facts_notes` and `chat.script[].answer` keep `\n` |

| wrong `claim_token` | `400 {"ok":false,"error":"bad_claim_token"}` |
| the untouched fixture | `200 {"ok":true,"slug":"fe5banr3rvgv4pt7mpiz","sha256":"42245443c1...","demo_url":"..."}` |
| replaying the same publish | `409 {"ok":false,"error":"illegal_transition","from":"generated","to":"generated"}` |

`GET review` returns one row per job in `generated`, `approved`, `refused`, `error`, `expired` or
**`delivery_failed`** (pass 2), each with `generated_at`, `demo_url`, `unsub_token` and the same
three signed links the claim response carries: `approve_url`, `reject_url`, `preview_url`.

`delivery_failed` was missing from that list and that made it a black hole: the state had a legal
`delivery_failed -> emailed` edge for a retried send, but nothing ever listed the job again, so
the retry could never happen and the lead was lost silently. Observed after adding it:

| step | observed |
| --- | --- |
| `status` a job `error -> delivery_failed` | `200 {"ok":true,"state":"delivery_failed"}` |
| `GET review` | job now listed, `"state":"delivery_failed"` |
| `status` it `delivery_failed -> emailed` with a `message_id` | `200 {"ok":true,"state":"emailed"}` |

`POST status`, exercised against a second job:

| transition | observed |
| --- | --- |
| `claimed -> error` with no claim token | `400 {"ok":false,"error":"bad_claim_token"}` |
| `claimed -> emailed` | `409 {"error":"illegal_transition","from":"claimed","to":"emailed"}` |
| `claimed -> pending` (runner aborting cleanly) | `200 {"ok":true,"state":"pending"}` |
| `claimed -> error` with `attempts: 3` | `200 {"ok":true,"state":"error"}`, attempts stored and read back by the next `claim` |
| `claimed -> pending` with `attempts: 3` | `200 {"ok":true,"state":"pending"}`; the NEXT claim retires it (see above) |
| `error -> emailed` with `message_id` (apology sent) | `200 {"ok":true,"state":"emailed"}` |
| `emailed -> approved` | `409 {"error":"illegal_transition","from":"emailed","to":"approved"}` |
| unknown job id | `400 {"ok":false,"error":"unknown_job"}` |
| `approved -> emailed` with `message_id` **(pass 2)** | `200 {"ok":true,"state":"emailed"}`, and the row's `message_id` column is now populated. The runner used to fold the provider id into `detail`, so it landed in the `error` column and the column that traces a delivery back to Resend stayed null on every job |
| `delivery_failed -> emailed` **(pass 2)** | `200 {"ok":true,"state":"emailed"}` |

`POST claim` with `DEMOGEN_MAX_JOBS_PER_DAY:0` and one claimable job **(pass 2)**:
`204` with `X-DemoGen-Reason: daily_cap`, and `runner/debug` reports
`"max_jobs_per_day": 0`. Under the old `Number(maxPerDay) || 8` this returned the job: a
deliberate pause of the funnel silently restored the default cap of 8.

### Serving gate: GET /demo/js/robots/g-&lt;slug&gt;/def.json

| case | observed |
| --- | --- |
| before approval (state `generated`) | `404` |
| `?preview=<approve token for this job>` | `200`, `Cache-Control: no-store` |
| `?preview=abc` | `404` |
| `?preview=<approve token for a DIFFERENT job>` | `404` (the token's job must own the slug) |
| `?preview=<an EXPIRED approve token>` | `404` |
| any other filename under `g-<slug>/`, e.g. `scene.js` | `404` |
| slug that fails `^[a-z2-7]{20}$`, e.g. `g-SHORT` | `404` |
| `POST` instead of `GET` | `405` |
| `HEAD` before approval | `404` |
| after approval | `200`, 6470 bytes |

Headers after approval:

```
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=3600
cache-tag: demogen-fe5banr3rvgv4pt7mpiz
x-content-type-options: nosniff
cross-origin-resource-policy: same-origin
```

`gen_view` is counted through `ctx.waitUntil`. It undercounts behind the edge cache, which
is the accepted trade for a one hour `max-age`.

**No cache purge is implemented (2026-07-27 pass 2, corrected).** The `cache-tag` header above is
emitted so a purge CAN be wired later, but nothing calls the purge API today. Rejecting a demo
that was already approved deletes the bundle row and 404s the origin, while an edge that has
already cached the def keeps serving it for up to the one hour `max-age`. Accepted residual: a
reject lands minutes after generation, before the link has been sent to anyone. Do not read the
`cache-tag` header as evidence that a reject invalidates caches.

#### The ASSETS fallthrough, and what actually lives on disk

**(2026-07-27 pass 2, corrected.)** The old text here described a committed bundle at
`demo/js/robots/g-aaaaaaaaaaaaaaaaaaaa/def.json` and quoted a `200` for it. There is no such
directory. The loader's dev fixture is `demo/js/robots/gen-fixture/` (a hand-written `def.json`
plus `harness.mjs`), it has no `g-` prefix so this route never sees it, and `.assetsignore`
excludes it so it is not served at all. Verified now:

| curl | observed |
| --- | --- |
| `GET /demo/js/robots/gen-fixture/def.json` | `404`, assetsignored: it is a dev fixture, not a page the visitor can reach |
| `GET /demo/js/robots/g-aaaaaaaaaaaaaaaaaaaa/def.json` | `404`, the DO has never heard of the slug and there is no asset behind it either |
| `GET /demo/js/robots/g-BADSLUG/def.json` | `404`, the slug regex rejects it before any lookup |
| `def.json` for a rejected job | `404`, hard, no fallthrough |

The fallthrough itself is RETAINED, deliberately, even with nothing currently behind it. It costs
one branch, and it is the safety net that lets a `g-`-prefixed bundle be committed later (or an
asset be restored) without the DO route silently shadowing it. The rule stands: a slug the DO has
never heard of is not a generated demo and goes back to `env.ASSETS.fetch`; a slug the DO DOES
know never falls through, in any state.

### Approve and reject

Both are signed per-job HMAC links, not the runner bearer, so they work from Hugh's phone
and a link scanner cannot commit anything.

| case | observed |
| --- | --- |
| `GET /api/demo-gen/approve?t=` | `200` confirm page: robot name, email summary, use case, destination address, bundle size and sha, a preview link, a raw def.json link, and a single button in a `method="POST"` form |
| `POST /api/demo-gen/approve?t=` | `200` "Approved", state `generated` to `approved`. **(2026-07-28)** the body no longer says "the runner picks this up on its next tick and emails the link": the runner is off, so it promises only that the link serves and states that sending is a separate step |
| `POST` the same link again | `409` "Already handled" |
| a correctly signed approve token whose expiry has passed | `400` "That link is not valid" |
| `GET /api/demo-gen/reject?t=` **(pass 2)** | `200` confirm page, and `def.json?preview=` still `200` afterwards: the GET renders and commits nothing |
| `POST /api/demo-gen/reject?t=` | `200` "Rejected", state to `rejected`, bundle row deleted |
| def.json after the reject | `404` |
| `POST` the approve link after the reject | `409` "Already handled" |

**The preview link on both confirm pages carries the token now (pass 2).** It used to be a bare
`/demo/#/connect/g-<slug>`, which 404s for anything not yet approved, so the one link whose entire
purpose is "look before you decide" never worked. It is now
`/demo/?preview=<approve token>#/connect/g-<slug>`, query BEFORE the hash so `generated.js` finds
it in `location.search`.

The REJECT page mints its own APPROVE-purpose token for its preview and raw-def links. The page
kind and the purpose of the links on it are independent: a reject page you cannot look at the demo
from is a reject page you cannot make a decision on. Observed on a job in `generated`:

| case | observed |
| --- | --- |
| `GET def.json`, no token, state `generated` | `404` |
| `GET def.json?preview=<token from preview_url>` | `200`, `Cache-Control: no-store` |
| the `preview_url` page itself | `200`, the demo app's `index.html` |

## Phase B: lease expiry and daily cap

Restarted with `--var DEMOGEN_LEASE_MS:1500 --var DEMOGEN_MAX_JOBS_PER_DAY:5`. DO state
survives a `wrangler dev` restart (`.wrangler/state`), so the day's claim count carries over.

| step | observed |
| --- | --- |
| claim | `200`, `state=claimed`, `lease_until` 1.5s out |
| wait 3s, then `GET queue` | `claimable` back to 1, `claimed_today` 4 |
| job row after the reclaim | `state=pending`, `claim_token=null`, `attempts=[]` preserved |
| the dead runner publishes with its stale token | `409 {"error":"illegal_transition","from":"pending","to":"generated"}` |
| re-claim | `200`, same job id, a different claim token |
| claim once the day's count hits the cap | `204` with `X-DemoGen-Reason: daily_cap` |

Event counters after the phase: `claimed` 5, `lease_reclaimed` 1.

## Signup lead capture (new 2026-07-28)

`worker/signup-lead.js`, shimmed from `site-worker.js` on two exact paths. Run it on the same
`wrangler dev` as everything above; the routes need `DEMOGEN_TOKEN` (for the export) and read
`DEMOGEN_SIGNING_KEY` (for the keyed IP hash). Add `--var DEMOGEN_DEV_NO_EMAIL:1`, always: see
"Email in dev" below for why a real Resend call cannot be driven from `wrangler dev`.

Every answer carries `Cache-Control: no-store`. **202 is the only success it admits to, and it
covers every silent drop**: a filled honeypot, an address already on the list, an IP past its daily
cap, the whole route past its daily cap, and either edge rate limiter refusing all answer exactly
like an accepted lead. Anything else would make this endpoint an oracle for "is this person already
on the list", and a `429` in particular would tell a bot exactly where the wall is.

**The four ceilings, cheapest first.** They nest, and nothing past any of them writes a row or
sends a mail:

| ceiling | where | limit | over it |
| --- | --- | --- | --- |
| `LEAD_RL_IP` | Cloudflare edge, before the body is read | 5/60s per `CF-Connecting-IP`, per POP | `202`, log `[signup-lead] rl-drop ip` |
| `LEAD_RL_ALL` | Cloudflare edge, before the body is read | 60/60s keyless, per POP | `202`, log `[signup-lead] rl-drop global` |
| per-IP daily cap | the DO, atomic with the insert | 5 NEW leads per keyed IP hash per rolling 24 h | `202`, log `[signup-lead] capped` |
| global daily cap | the DO, atomic with the insert | 500 NEW leads per UTC day (`DEMOGEN_LEAD_DAILY_CAP`) | `202`, log `[signup-lead] daily_capped` |

Beside them sits the notification budget, which is NOT a ceiling on leads: 25 mails per UTC day,
counted in the DO on the same append-only `events` ledger the job cap uses. Past it the lead is
stored, exported and logged as `[signup-lead] notify-budget lead=<address>`, and only the Resend
call is skipped.

### POST /api/signup-lead

```sh
curl -i -X POST localhost:8787/api/signup-lead -H 'content-type: application/json' \
  -d '{"email":"lead@example.com","hp":"","dwell_ms":4200,"robot":"sbr","src":"dm"}'
```

| curl | observed |
| --- | --- |
| the body above | `202 {"ok":true}`, one `leads` row, one Resend notification to `hughphan2@gmail.com` |
| the same body again | `202 {"ok":true}`, still ONE row, `last_seen` bumped, `created_at` / `robot` / `src` / `dwell_ms` untouched, **no second email** |
| `"email":"  Lead@Example.COM "` | `202`, stored as `lead@example.com` (trimmed, lowercased), and a later post of `LEAD@example.com` is the duplicate path |
| `"hp":"http://spam.example"` | `202 {"ok":true}`, no row, no DO call at all, no email. Checked BEFORE the address, so a bot cannot tell a filled honeypot from a rejected address |
| `"email":"nope"` / `"no@domain"` / missing / 250-char local part | `400 {"ok":false,"reason":"bad_email"}`, no row |
| `-d '{oops'` / `-d '[]'` / `-d 'null'` / `-d '42'` | `400 {"ok":false,"reason":"bad_json"}` |
| a body over 8 KB, or a `Content-Length` claiming over 8 KB | `400 {"ok":false,"reason":"bad_json"}`. The declared length is checked first, so an oversized body is refused before it is read |
| **(hardening)** 40 KB posted with `Transfer-Encoding: chunked` and NO `Content-Length` | `400 {"ok":false,"reason":"bad_json"}` in ~1 ms. The body is read from `request.body`'s reader and the reader is CANCELLED the moment the running total would cross 8 KB, so the rest of the body is never pulled across and nothing oversized is ever allocated. This is the row the old `await request.text()` could not pass: chunked declares no size, so the cap ran after the buffering it existed to prevent |
| a 4 KB `src` | `202`, and `src` is truncated to 64 chars on the way in (same for `robot`) |
| a 6th NEW address from the same IP inside 24 h | `202 {"ok":true}`, no row, no email. The cap is 5 new leads per IP per rolling day |
| a DUPLICATE from an IP already at the cap | `202`, `last_seen` still bumps. Dedupe is checked before the cap, so a returning lead is never swallowed by it |
| the 6th address from a DIFFERENT IP | `202`, row written, email sent. The per-IP cap is per IP; the 500/day one below is the global ceiling |
| **(hardening)** 7 posts in a row from one `cf-connecting-ip` | five `202`s that store a row, then two `202`s logging `[signup-lead] rl-drop ip`. Observed on 2026-07-28: the limiter counts in `wrangler dev`, no extra flag needed |
| **(hardening)** the 501st NEW address of the UTC day, from a fresh IP | `202 {"ok":true}`, no row, no email, log `[signup-lead] daily_capped`. Drive it locally with `--var DEMOGEN_LEAD_DAILY_CAP:2` rather than 501 curls; `--var DEMOGEN_LEAD_DAILY_CAP:0` pauses the capture outright and every post is a silent `202` |
| **(hardening)** the 26th NEW lead of the UTC day | `202`, row WRITTEN, present in the export, no Resend call, log `[signup-lead] notify-budget lead=...`. The budget bounds the inbox, never the list |
| **(hardening)** `LEAD_RL_IP` / `LEAD_RL_ALL` unbound and `DEV` unset | `503 {"ok":false,"error":"not configured"}`, and the DO is never reached. A public write path to the DO fails closed, exactly as `chat.js` does for its API key |
| `GET` / `PUT` / `DELETE` / `HEAD` on `/api/signup-lead` | `405 {"ok":false,"reason":"method_not_allowed"}` |
| Resend 500s, times out or throws | still `202`, row already written. Storage is the source of truth and the send runs in `ctx.waitUntil` after the response is out |

The stored row is `email, robot, src, dwell_ms, ip_hash, created_at, last_seen`. `ip_hash` is
`sha256(ip + DEMOGEN_SIGNING_KEY)` truncated to 32 hex chars, exactly the idiom the job table uses:
the raw IP is never stored, and the digest exists only to hold the per-IP cap.

**Confirming a row landed is the BEARER LIST ROUTE, not the debug route.**
`GET /api/demo-gen/runner/debug` dumps jobs, event counters, the suppression list and bundles, and
`DemoGenDO.debug()` does not read the `leads` table at all, so it can neither confirm nor deny that
a capture stored anything. The one assertion path is:

```sh
curl -s -H "Authorization: Bearer $DEMOGEN_TOKEN" localhost:8787/api/signup-lead/list \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["count"], [l["email"] for l in d["leads"]])'
```

The debug route is still the right tool for the assertion it CAN make about this route, which is
the negative one every silent-drop row above depends on: that the capture created no job row.

### GET /api/signup-lead/list

The export path, and the only way the leads come out. Same bearer and same constant-time compare
as `/api/demo-gen/runner/*`.

```sh
curl -s -H "Authorization: Bearer $DEMOGEN_TOKEN" localhost:8787/api/signup-lead/list
```

**(2026-07-28 hardening.)** The response is an OBJECT now, not a bare array, because a page that
truncated has to be able to say so. Observed on `wrangler dev` after five captures:

```json
{"ok":true,"count":5,"next_before":null,"next_before_email":null,
 "leads":[{"email":"rl5@example.com","robot":null,"src":"dm","dwell_ms":1000,
           "created_at":"2026-07-28T08:39:27.696Z","last_seen":"2026-07-28T08:39:27.696Z"}]}
```

Paging is a COMPOUND cursor over (created_at DESC, email DESC), not an offset: the table grows at
the TOP, so an offset would re-serve rows every time a lead landed mid-walk, and a timestamp-only
cursor loses a row when two leads share the millisecond at a page boundary (email is unique after
dedupe, so the compound ordering is total). A truncated page names BOTH halves; feed them straight
back together:

```sh
curl -s -H "Authorization: Bearer $DEMOGEN_TOKEN" \
  'localhost:8787/api/signup-lead/list?before=2026-07-28T08:39:27.679Z&before_email=rl3%40example.com'
# -> {"ok":true,"count":2,"next_before":null,"next_before_email":null,"leads":[rl2, rl1]}
# `before_email` WITHOUT `before` -> 400 bad_cursor. `before` alone is accepted (first-page-after-
# a-time), it just cannot land inside a tie.
```

| case | observed |
| --- | --- |
| no `Authorization` header | `401 {"ok":false,"error":"unauthorized"}`, and the DO is never called |
| `Bearer nope`, the token plus one char, the token minus one char | `401 {"ok":false,"error":"unauthorized"}` |
| right bearer | `200`, `Cache-Control: no-store`, `{ok, count, next_before, leads}`, newest `created_at` first |
| response content | each lead is `email, robot, src, dwell_ms, created_at, last_seen`. **No `ip_hash`**: it is a rate-limit bucket, not a fact about the lead, and an export carrying it would have to be handled like one carrying IPs |
| a page under 1000 rows | `next_before: null`. Null is the end of the walk, and it is the ONLY end condition: an empty `leads` array is not required |
| more than 1000 rows | `count: 1000` and `next_before` set to the OLDEST returned row's `created_at`. The Worker asks the DO for 1001 and returns 1000; the extra row exists only so "there is more" is observed rather than inferred from a full page |
| `?before=<ISO>` | rows STRICTLY older than the cursor, so the row the cursor names is never repeated. Walking to the end gives `{"count":0,"leads":[],"next_before":null}` rather than looping |
| `?before=nope` / `?before=` / `?before=yesterday` | `400 {"ok":false,"reason":"bad_cursor"}`. A bad cursor is refused rather than ignored: silently serving page one would read exactly like a list that had stopped growing, which is the one wrong answer an export must never give |
| `POST /api/signup-lead/list` with the right bearer | `405 {"ok":false,"reason":"method_not_allowed"}` (bearer is checked first, so a wrong bearer on any verb is still `401`) |
| `GET /api/signup-lead/nope` | `404` with an EMPTY body: `site-worker.js` matches the two paths exactly rather than by prefix, so a typo below them falls through to `env.ASSETS.fetch`, not to the JSON 404 |

Note the list route is deliberately NOT rate limited. It is bearer gated with a constant-time
compare and it is Hugh's own export path; putting a 5/60s wall in front of a paging walk would
break the one caller it has.

## Email in dev: HISTORICAL

**(2026-07-28, shelve.)** `demo-gen.js` sends no email. The verification mail was the only mail it
ever sent, and it went with the submit path when the entry was shelved: there is no mail function,
no mail counters and no Resend call left in that file, which is why the unit test can assert zero
sends from the tombstone simply by handing the handler a `fetch` that throws. Visitor delivery and
Hugh's approval notice are the RUNNER's job (`mailer.mjs`, `notify.mjs`, keyed by `RESEND_API_KEY`
out of `pass`), not the Worker's, and the runner is off for the shelve.

**(2026-07-28, signup leads.)** One Worker-side send came BACK, in `worker/signup-lead.js` only:
a plain-text notification to `hughphan2@gmail.com` per NEW lead, on the shelved path's exact idiom
(`DEMOGEN_RESEND_KEY`, `DEMOGEN_FROM` or the `Hugh at Alloy <hugh@alloylogger.com>` fallback,
`AbortSignal.timeout(10_000)`, every failure caught and logged). It is a notification, not a
delivery: it runs inside `ctx.waitUntil` after the `202`, and the `leads` row is the record whether
or not it lands.

**(2026-07-28, hardening.)** That send is budgeted at 25 a UTC day, counted in the DO on the
`events` ledger as `signup_lead_notified` beside the `signup_lead` rows the daily cap counts. The
budget is spent when the DECISION is made, inside the same atomic `recordLead` call that wrote the
row, not when Resend answers: a failed send that handed its slot back would turn a provider outage
into a retry storm, and two simultaneous leads must not both read the last slot as free. Past the
budget the lead is stored and exported exactly as always and only the mail is skipped, which is the
right way round, because the row is the record and the email is a nudge.

`DEMOGEN_DEV_NO_EMAIL:1` therefore gates one thing again. It is inert for `demo-gen.js` (kept in
the dev command so a copy-paste matches what earlier sessions ran) and live for `signup-lead.js`,
where it logs the lead instead of calling Resend. **Set it for every local run**, per the paragraph
below: the mail leg of the lead capture cannot be exercised against `wrangler dev` at all, only
against a deployed preview.

What was true before the shelve is kept here because it is the thing to re-read if the entry is
ever reopened, and because it still describes this machine rather than that code path: with a real
Resend key set, an outbound `fetch` to `https://api.resend.com/emails` kills the local `workerd`
process (`503 Your worker restarted mid-request` after ~180 ms when awaited; a prompt `202` and no
recorded outcome when deferred to `ctx.waitUntil`), while the same request from `curl` on the same
machine gets Resend's expected `401`. That is a local `wrangler dev` outbound-fetch limitation, not
a code path, and it is the same reason `/demo/api/chat` answers `503` locally. Any future mail leg
in this Worker has to be proved against a deployed preview, never against `wrangler dev`.

## Runner response contract

The keys each runner route returns. This block is MACHINE READ: `sync-template.sh` copies this
file into the runner's `runtime/` snapshot, and `test/fixtures.test.mjs` parses the JSON below and
asserts that every key in `fixtures/api/*.json` appears in it. That is the tripwire the whole
"fixtures must derive from reality" rule needs: a fixture can only contain keys the Worker
actually documents, so a fixture invented from an assumed contract fails a test instead of
teaching the runner a shape the Worker never sends.

Keep this in sync with `handleRunner()` in `demo-gen.js`. Adding a key means adding it here.

```json
{
  "queue": ["open", "claimable", "approved_unsent", "pending", "oldest_age_s", "claimed_today"],
  "claim": ["job", "claim_token"],
  "claim.job": [
    "id", "slug", "email", "use_case", "robot_seen", "created_at", "attempts", "claim_token",
    "lease_until", "runner", "unsub_token", "demo_url", "approve_url", "reject_url", "preview_url"
  ],
  "review": ["jobs"],
  "review.jobs": [
    "id", "slug", "state", "robot_name", "use_case", "email", "email_summary", "device_id",
    "created_at", "updated_at", "generated_at", "approved_at", "error", "demo_url",
    "approve_url", "reject_url", "preview_url", "unsub_token"
  ],
  "publish": ["ok", "slug", "sha256", "demo_url"],
  "status": ["ok", "state"],
  "state": [
    "unverified", "pending", "claimed", "generated", "approved", "refused", "error", "expired",
    "delivery_failed", "emailed", "rejected", "unknown", "review_total", "next_claim_expiry_s"
  ],
  "shelf-purge": [
    "ok", "unverified_deleted", "allowlisted_deleted", "bundles_deleted", "deleted", "refused",
    "not_found"
  ],
  "_fixture_only": ["_captured", "route", "note"]
}
```

`state` is one key per entry of `LEGAL_TRANSITIONS` in `worker/do.js`, plus the three extras
(`unknown`, `review_total`, `next_claim_expiry_s`). That enum is normative: a state added to the
machine and not added here is a count the shelve's drain gate would read as zero while work was
still queued. A state NOT in the enum never becomes a key: it is counted under `unknown`, so this
list is the complete field set no matter what is in the jobs table.
`worker/demo-gen.unit.test.mjs` reads the enum out of `do.js` and asserts the response's key set
against it, so the two cannot drift silently.

`_fixture_only` is the annotation header the fixture files carry (which capture, from where, and
what the fixture is for). The transport ignores those keys; they exist so nobody has to guess
whether a fixture is real.

## Not covered here

- The `expired` state has no sweeper in the Worker. It is only reachable through
  `POST status`, which is deliberate: the 7 day unverified and 48 hour stale sweeps are the
  runner's job, and a DO alarm doing the same thing would be a second clock to keep honest.
- Deep semantic validation of a def (data build determinism, part-ref resolution, findings
  variance, matcher coverage) stays in the runner's `validate.mjs`. The Worker re-check is
  structural only, and is the backstop that a bundle cannot become servable without passing.
- `cloud/` is untouched. `cd cloud && npm ci && npm test` still passes: 1 file, 5 tests.
- The runner side of `delivery_failed` recoverability. The Worker's half is done (the state is
  listed by `review` and the `delivery_failed -> emailed` edge exists); the half that decides WHICH
  mail to retry lives on the Mac, and its fix is staged at `worker/runner-patches/` with its own
  tests. It is installed by hand at shelve time, never by a deploy: see that directory's
  `INSTALL.md`.
