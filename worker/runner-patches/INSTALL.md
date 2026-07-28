# Staged runner patch: persisted mail-kind marker (delivery-failure recoverability)

Referenced by the shelve plan's shutdown step 2b. **Nothing here is installed by merging or
deploying.** It goes into `~/.local/bin/alloylogger-demo-runner/` by hand, at shelve execution
time, AFTER Hugh's approval and AFTER the LaunchAgent is disabled and booted out.

The live runner is not a git worktree and the LaunchAgent reloads `runner.mjs` from disk every
300 s, so editing it before the service is stopped would swap the code out from under a tick that
may be mid-generation. That is the whole reason this lives in the repo branch instead.

## What it fixes

A send that fails deletes its own `sent-<kind>.marker` (correct: nothing was delivered, so the
retry must really send) and the job moves to `delivery_failed`. But `delivery_failed` does not
record WHICH of the three mails failed, the state it failed from is gone, and the only thing that
ever knew the kind was the marker just deleted. The next sweep therefore found a markerless
`delivery_failed` job, logged "nothing to retry", and skipped it on every tick forever. A real
failure was permanently stuck and the lead was lost silently.

The fix is a SECOND, separate marker:

| file | means | lifecycle |
| --- | --- | --- |
| `sent-<kind>.marker` | a real email left this machine, skip the send and retry only the status post | written before the send, taken back if the send did not land. **Unchanged.** |
| `intent-<kind>.marker` | this job's delivery is the `<kind>` mail | written when the intent is known, including on dry runs, and never removed |

`sweepOne()` resolves a `delivery_failed` retry from the sent marker first (the rarer case where
the mail really left and only the status post failed, which must still not re-send) and falls back
to the intent marker (the common case: the send failed, so the retry makes a REAL second provider
call). A row with neither marker is still skipped rather than guessed at.

The sent marker's dedupe semantics are not touched. Its contract test,
`test/runner.test.mjs:287` ("a real send writes a marker, marks emailed, and never goes out
twice"), is unmodified and still passes.

## Files

| staged | installs to |
| --- | --- |
| `runner.mjs` | `~/.local/bin/alloylogger-demo-runner/runner.mjs` |
| `test/delivery-retry.test.mjs` | `~/.local/bin/alloylogger-demo-runner/test/delivery-retry.test.mjs` |
| `runner.mjs.diff` | unified diff against the live source as of 2026-07-28, for review only |

Base: live `runner.mjs` sha1 `f32bbb5736a1b74bac02a9dd564302729c239331`.
Staged `runner.mjs` sha1 `57cedde0b1f6d1483a953ba4662ce630aafe9897`.

No other runner file changes. No dependency changes.

## Order

Nothing here is optional and nothing here reorders:

1. disable, wait for inactive, bootout (plan step 7.1 and 7.2, verified by step 0 below)
2. install the patch (steps 1 to 3) and prove it with `npm test`
3. resync the runtime snapshot from the MERGED repo path, verify `MANIFEST.json` (step 4)
4. only then the first supervised tick (step 5)

A tick before step 3 smokes the generated demo against the pre-shelve snapshot; a tick run as
`node runner.mjs` instead of `run.sh` starts with no `DEMOGEN_TOKEN` at all and, if it somehow got
past that, would mail nothing.

## Install (steps 0 to 3)

Run from the merged repo root. Step 0 is not optional: if the base sha does not match, the live
runner has been edited since this patch was staged and the diff must be re-reviewed first.

```sh
RUNNER=~/.local/bin/alloylogger-demo-runner
PATCHED=worker/runner-patches

# 0. the service must already be disabled and inactive (plan step 7.1 and 7.2)
launchctl print-disabled gui/$UID | grep alloylogger-demo-runner
#   must print `"com.hugh.alloylogger-demo-runner" => disabled`. `print` failing on its own only
#   says the job is not loaded RIGHT NOW; the disabled override is what stops launchd starting it
#   again between this check and the last copy below.
launchctl print gui/$UID/com.hugh.alloylogger-demo-runner   # must FAIL
pgrep -fl alloylogger-demo-runner                            # must print nothing

# 1. confirm the base is what this patch was cut against
shasum "$RUNNER/runner.mjs"   # expect f32bbb5736a1b74bac02a9dd564302729c239331

# 2. back up, then install
cp "$RUNNER/runner.mjs" "$RUNNER/runner.mjs.pre-delivery-kind"
cp "$PATCHED/runner.mjs" "$RUNNER/runner.mjs"
cp "$PATCHED/test/delivery-retry.test.mjs" "$RUNNER/test/delivery-retry.test.mjs"

# 3. prove it on the machine it now lives on
cd "$RUNNER" && npm test
```

`npm test` must be green: 140 tests (134 before this patch, plus the 6 new delivery-retry ones).
It is offline apart from the browser smoke gate, which launches the pinned local Chromium.

## 4. Resync the runtime snapshot (MANDATORY, before any tick)

Plan step 2b. The runner does NOT read the repo at tick time (no TCC grant for `~/Documents` under
launchd), it reads its own `runtime/` snapshot, and `smoke.mjs` serves that snapshot as the
document root for the browser gate every generation has to pass. A supervised remediation tick
would therefore smoke a generated demo against whatever `demo/` looked like the last time anyone
synced, which right now is the pre-shelve app: it still has `leadform.js` and would 404 on
`signup.js`. Do this BEFORE the first tick, not after.

**Pass the repo path explicitly.** `sync-template.sh` defaults to
`~/Documents/alloy-logger-arduino-demogen`, a stale worktree that knows nothing about this branch.
The default is the wrong answer here every time.

```sh
REPO=~/Documents/alloy-logger-arduino    # the MERGED revision, not the demogen worktree
"$RUNNER/sync-template.sh" "$REPO"

# verify the snapshot is the shelved app, not the pre-shelve one
grep -c 'demo/js/core/signup.js'   "$RUNNER/runtime/MANIFEST.json"   # must be >= 1
grep -c 'demo/js/core/leadform.js' "$RUNNER/runtime/MANIFEST.json"   # must be 0
```

Both checks must hold before step 5. `MANIFEST.json` also records the git revision it was cut
from: confirm it is the merged commit, so a stale snapshot is a visible fact rather than a mystery
diff in a generated demo.

## 5. Supervised remediation ticks

Run ticks through `run.sh`, never `node runner.mjs` bare. `run.sh` IS one tick per invocation, and
it is the only thing that loads the environment the tick needs: `DEMOGEN_TOKEN` out of
`pass alloylogger/demogen-token` (`api.mjs` refuses to start without it) and `RESEND_API_KEY` out
of `pass alloylogger/resend-api-key` (without it `mailer.mjs` silently writes the mail dry, so a
delivery tick would report success and deliver nothing, which is exactly the failure the drain
gate is meant to catch). It also takes the `mkdir` lock, so a supervised tick cannot collide with
anything else, and appends to `run.log`.

```sh
# one tick, real delivery. DEMO_MAILER defaults to `dry` inside run.sh, so pass it explicitly
# whenever the tick is meant to actually send.
cd "$RUNNER" && DEMO_MAILER=resend ./run.sh

# watch what it did
tail -n 40 ~/.local/state/alloylogger-demo-runner/run.log      # run.sh's own log
tail -n 40 ~/.local/state/alloylogger-demo-runner/runner.log   # one line per state transition
```

Leave `DEMO_MAILER` unset for a dry rehearsal tick (mail is written beside the job instead of
sent). `gpg`/`pass` need the interactive terminal's agent, which is another reason these ticks are
run by hand and not by launchd.

If a tick has to be run without `run.sh` for some reason, the environment has to be sourced the
same way it does it: `export DEMOGEN_TOKEN="$(pass show alloylogger/demogen-token)"` and
`export RESEND_API_KEY="$(pass show alloylogger/resend-api-key | head -n 1)"`, plus
`DEMOGEN_BASE`, `DEMO_MAILER`, `DEMO_NOTIFY` and `MAX_JOBS_PER_DAY`, and the run.lock has to be
taken by hand. Prefer `run.sh`.

## Rollback

```sh
cp ~/.local/bin/alloylogger-demo-runner/runner.mjs.pre-delivery-kind \
   ~/.local/bin/alloylogger-demo-runner/runner.mjs
rm ~/.local/bin/alloylogger-demo-runner/test/delivery-retry.test.mjs
```

Leftover `intent-*.marker` files are inert to the old code, which only ever looks for
`sent-*.marker`, so a rollback needs no cleanup of the state directory.

## After installing

Ticks are one at a time, watched, and read out of both logs before the next one. A
`delivery_failed` job that keeps failing will keep failing once per tick with no duplicate sends;
a permanently undeliverable address is ended with the Hugh-allowlisted shelve purge, not by
retrying it forever. The drain is complete when `GET /api/demo-gen/runner/state` reports
`pending`, `claimed`, `generated`, `approved`, `delivery_failed`, `review_total` and `unknown` all
zero.
