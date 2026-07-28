# demo-gen curl matrix

Manual acceptance matrix for `worker/demo-gen.js` + `worker/do.js` against `wrangler dev`.
Every line below was run on 2026-07-27 from the repo root; the responses are the observed
ones, not expected ones. Re-run this after any change to either file.

The rows marked **(2026-07-27 pass 2)** were re-run after the fresh-eyes review fixes, on a
second `wrangler dev` on port 8788 with its own `--persist-to` directory. The captured
responses from that run are also what `~/.local/bin/alloylogger-demo-runner/fixtures/api/*.json`
now contains, byte for byte: the runner's offline transport replays real worker output rather
than a hand-written guess at it.

There is no automated test runner for the site Worker (the repo has no test harness outside
`cloud/`), so this file is the contract.

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
- `DEMOGEN_DEV_NO_EMAIL:1` short circuits the Resend call, logs the verification link and
  records a `verify_mail_sent` event. See "Email in dev" below.
- `DEMOGEN_LEASE_MS` (Phase B only) shortens the 30 minute claim lease so the reclaim path
  is testable in seconds. Never set it in production.
- `DEMOGEN_MAX_JOBS_PER_DAY` overrides the `vars` default of 8. **(2026-07-27 pass 2)** `0` now
  means zero: the DO parses it with `Number.isFinite` instead of `Number(x) || 8`, so setting it
  to `0` pauses the funnel instead of silently restoring the default cap.

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

### POST /api/demo-gen/submit

```sh
UC='2v2 RoboCup open-league soccer sim, 4 agents on ROS 2, we keep losing the ball on defensive clears'
curl -X POST localhost:8787/api/demo-gen/submit -H 'content-type: application/json' \
  -H 'CF-Connecting-IP: 198.51.100.1' \
  -d "{\"email\":\"lead1@example.com\",\"use_case\":\"$UC\",\"dwell_ms\":9000,\"robot_seen\":\"sbr\",\"website\":\"\"}"
```

| case | body sent | observed | job row |
| --- | --- | --- | --- |
| happy path | above | `202 {"ok":true}` | created, state `unverified` |
| honeypot | `"website":"http://spam"` | `202 {"ok":true}` | none, event `honeypot` |
| dwell too short | `"dwell_ms":400` | `202 {"ok":true}` | none, event `dwell_block` |
| dwell absent | no `dwell_ms` | `202 {"ok":true}` | none, event `dwell_block` |
| bad email | `"email":"not-an-email"` | `400 {"ok":false,"reason":"invalid"}` | none |
| no dot in domain | `"email":"a@localhost"` | `400 {"ok":false,"reason":"invalid"}` | none |
| use_case under 40 chars | `"use_case":"too short here"` | `400 {"ok":false,"reason":"invalid"}` | none |
| use_case under 5 tokens | 48 chars, 2 tokens | `400 {"ok":false,"reason":"invalid"}` | none |
| robot_seen not in the four ids | `"robot_seen":"pirate"` | `400 {"ok":false,"reason":"invalid"}` | none |
| malformed JSON | `{oops` | `400 {"ok":false,"reason":"invalid"}` | none |
| wrong content-type | `content-type: text/plain` | `415 {"ok":false,"reason":"invalid"}` | none |
| body over 4KB | 6000 char use_case | `413 {"ok":false,"reason":"invalid"}` | none |
| GET instead of POST | | `405 {"ok":false,"reason":"invalid"}` | none |

Every response carries `Cache-Control: no-store` and no CORS headers.

### Rate windows, dedupe, suppression

Four submits from `CF-Connecting-IP: 203.0.113.77`, four different emails and use cases:

| submit | observed |
| --- | --- |
| 1, 2, 3 | `202 {"ok":true}` |
| 4 | `429 {"ok":false,"reason":"rate"}`, event `rate_block_ip` |

| case | observed |
| --- | --- |
| resubmit an identical (email, use_case) pair from a different IP | `202 {"ok":true,"duplicate":true}`, event `submit_dedupe`, no second job row |
| third submit for the same email inside 24h (different use case, fresh IP) | `429 {"ok":false,"reason":"rate"}`, event `rate_block_email` |
| submit from a suppressed address | `202 {"ok":true}`, event `submit_suppressed`, no job row |

The dedupe hit still writes `submit_ip:` and `submit_email:` events, so repeating the same
submission cannot be used to probe the dedupe window for free.

`ip_hash` is `sha256(CF-Connecting-IP + DEMOGEN_SIGNING_KEY)` truncated to 32 hex chars. The
raw IP is never passed to the DO and never stored.

### GET /api/demo-gen/verify

```sh
T=$(node tok.mjs verify <job_id>)
curl -i "localhost:8787/api/demo-gen/verify?t=$T"
```

**(2026-07-27 pass 2)** Verify is now a GET/POST pair, like approve and reject already were. The
GET only renders; the POST commits. A mail provider or chat client that prefetches the link
"clicks" the GET before the human does, and a scanner-confirmed address is a lead we would build
a demo for that nobody asked to confirm. The rendered page auto-submits its own form via a
four-word inline script, so a real browser confirms in one frame and the visitor sees only the
result, while a scanner that does not run JS commits nothing. The visible button is the no-JS
path. Same treatment for unsubscribe, where the failure mode is a robot unsubscribing a visitor.

| case | observed |
| --- | --- |
| `GET /verify?t=` **(pass 2)** | `200`, page headed "One tap to confirm", `<form method="POST" action="/api/demo-gen/verify?t=...">` plus one auto-submitting inline script. Job row **still `unverified`** after the GET (confirmed via `runner/debug`) |
| `POST /verify?t=` **(pass 2)** | `200`, page headed "You're confirmed", job goes `unverified` to `pending` |
| `PUT /verify?t=` | `405 method not allowed` |
| second POST with the same token | `200`, page headed "Already confirmed", state unchanged |
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
| `POST /api/demo-gen/approve?t=` | `200` "Approved", state `generated` to `approved` |
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

## Email in dev

`DEMOGEN_DEV_NO_EMAIL:1` is the documented local path: `sendVerificationEmail` logs
`[demo-gen] verification email suppressed to=<addr> link=<verify link>` and returns ok, so
the DO records `verify_mail_sent` and the verify link is reconstructible. The matrix above
mints its own tokens with `tok.mjs` rather than depending on that log line.

**The live Resend leg could not be exercised locally.** With a real
`DEMOGEN_RESEND_KEY` set, the `fetch` to `https://api.resend.com/emails` kills the local
`workerd` process: the awaited version returns `503 Your worker restarted mid-request` after
~180ms, and the `ctx.waitUntil` version returns `202` promptly but never records either
`verify_mail_sent` or `verify_mail_failed`. The same request from `curl` on the same machine
returns `401` from Resend as expected, and the crash reproduces with the command sandbox
disabled, so this is a local `wrangler dev` / `workerd` outbound-fetch limitation and not a
code path. The same limitation is why `/demo/api/chat` answers `503` locally. What this
means:

- the request construction (bearer, `from` from `DEMOGEN_FROM`, `reply_to`, plain-text body,
  10s `AbortSignal.timeout`) is reviewed but not executed here;
- `verify_mail_failed` as an alarm counter is unproven end to end;
- both need re-checking against a deployed preview before the first real submission. That is
  step 10 of the plan's Phase 5 anyway (production smoke with Hugh's own email).

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
  "_fixture_only": ["_captured", "route", "note"]
}
```

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
