# UNO R4 + Alloy Device Wire v1 release handoff

Date: 2026-08-11 (Australia/Sydney)

Status: implementation and physical proof complete; review, branch isolation, commits, and deployment
remain. Nothing from this work has been committed, pushed, or deployed. The reference board was
left running a credential-free disconnect sketch.

## Outcome to preserve

This work adds a second Arduino device path without replacing the existing ESP32 CSV logger:

- an allocation-free, portable fixed-memory capture core for Alloy Device Wire v1;
- a cooperative Arduino UNO R4 WiFi adapter with verified TLS, retry, reconnect, clock anchors, and
  explicit loss accounting;
- a separate bounded `POST /v2/frame` Worker route and binary Durable Object lifecycle;
- typed binary-to-MCAP assembly; and
- reproducible host, Worker-runtime, cross-architecture compile, and physical hardware evidence.

The physical gate sent six missions through a local Worker to the real Alloy data API: normal,
forced Wi-Fi reconnect, dropped-response retry, fixed-RAM overflow, reset-before-END, and clean
post-reset capture. All six objects were listed and downloaded from Alloy Mesh, then independently
verified with an indexed MCAP reader. The exact run IDs and counts are in
[`uno-r4-hardware-baseline-2026-08-11.md`](uno-r4-hardware-baseline-2026-08-11.md).

Release success means all of the following are true:

- only the logger change set is present on a clean review branch;
- all portable, Worker, UNO R4, and legacy ESP32 gates pass there;
- an isolated staging deployment passes both legacy `/v1` and new `/v2` smoke tests;
- the previous production Worker version is recorded before production deployment;
- production health, one complete v2 mission, asynchronous finalization, Mesh download, and MCAP
  inspection pass;
- rollback remains immediately available;
- no supplied Wi-Fi password, Alloy API key, private key, local `.dev.vars`, or unrelated demo edit
  enters Git, logs, firmware evidence, or shell history; and
- deployment evidence is added to this handoff without including secret values.

## Hard stop: isolate the branch and working tree first

At this snapshot:

- repository: `/Users/hughp/Documents/alloy-logger-arduino`;
- current branch: `ux-wall-r2` at `d82e498`;
- observed `origin/main`: `2e663b8` (fetch again; this is not a release pin);
- current HEAD's complete same-day diff adds `test/` and `.uno-probe/` to `.assetsignore`, preventing
  the root site Worker from publishing those directories;
- the current branch already contains unrelated committed Donna/demo work; and
- the shared working tree also contains unrelated, actively changing `demo/**` edits.

Do **not** run `git add -A`, `git add .`, a broad stash, `git clean`, reset, checkout/restore, or a
branch switch in the shared source tree. Do not build the logger PR on `ux-wall-r2`: its existing
demo commits would follow the PR.

Use a clean worktree and a `codex/` branch from a freshly fetched, owner-confirmed base. Transfer
only the allowlisted files below into that worktree. Leave the shared source tree untouched so its
user-owned edits remain recoverable. Before committing, inspect both:

```sh
git status --short
git diff --check
git diff --name-status <confirmed-base>...HEAD
```

No `demo/**` path belongs in this release.

### Pre-existing mission patch: preserve, but do not silently absorb

Five mission-label changes predated the UNO work:

- `src/AlloyLogger.h`;
- the `doc["mission"]` hunk in `src/AlloyLogger.cpp`;
- `cloud/src/types.ts`;
- `cloud/src/mcap.ts`; and
- `cloud/test/mcap.test.ts`.

Their source-tree patch is saved on this Mac at
`/private/tmp/alloy-logger-arduino-pre-uno.patch`, SHA-256
`c1bf232f1361f68daabf97a6fe6de54d2c5f606ffa7f3c7a0d81019190988c0a`. At the final integrity
gate the checksum matched and `git apply --reverse --check` proved all five hunks were intact.

For the UNO/binary branch, omit those five pre-existing changes unless the owner explicitly chooses
to ship them as their own reviewed commit. The UNO work needs only the outer
`ARDUINO_ARCH_ESP32` guard from `src/AlloyLogger.cpp`; do not copy its unrelated mission hunk into
the feature commit. `src/AlloyLogger.h`, `cloud/src/types.ts`, `cloud/src/mcap.ts`, and
`cloud/test/mcap.test.ts` otherwise need no UNO/binary change.

## Logger change-set allowlist

Review and transfer these paths only. New files are currently untracked, so a plain `git diff`
does not capture the full feature.

### Portable protocol and core

- `src/alloy/device/core.cpp`
- `src/alloy/device/core.h`
- `src/alloy/device/protocol.cpp`
- `src/alloy/device/protocol.h`
- `test/portable/Makefile`
- `test/portable/test_main.cpp`
- `docs/alloy-device-wire-v1.md`

### UNO R4 adapter, examples, and evidence

- the exact `.assetsignore` hunk adding `test/` and `.uno-probe/`
- `src/AlloyUnoR4.h`
- `src/Alloy.h`
- `src/alloy/uno_r4/AlloyUnoR4.cpp`
- `src/alloy/uno_r4/UnoR4Platform.cpp`
- `src/alloy/uno_r4/UnoR4Platform.h`
- the first and last ESP32 guard hunks in `src/AlloyLogger.cpp` only
- `examples/UnoR4Starter/UnoR4Starter.ino`
- `examples/UnoR4Starter/arduino_secrets.h`
- `examples/UnoR4Telemetry/UnoR4Telemetry.ino`
- `examples/UnoR4Telemetry/arduino_secrets.h`
- `library.properties`
- `README.md` after reconciling its obsolete ESP32/CSV-only and binary-roadmap claims
- `.uno-probe/Disconnect/Disconnect.ino`
- `.uno-probe/UnoProbe/UnoProbe.ino`
- `.uno-probe/run_probe.py`
- `docs/uno-r4-wifi.md`
- `docs/uno-r4-hardware-baseline-2026-08-11.md`
- this handoff

The two `arduino_secrets.h` files must contain empty string placeholders at commit time. They are
tracked files, not ignored secret stores. Use an outside-repository sketch copy for any live flash
that requires real credentials. As a release-hardening option, the reviewer may replace them with
tracked `.example` templates plus a narrowly ignored local header, but that policy change must be
made consistently in both examples and docs and recompiled; do not merely add a broad ignore rule.

### Worker binary ingest

- `cloud/src/index.ts`
- `cloud/src/session-do.ts`
- `cloud/src/binary.ts`
- `cloud/src/binary-mcap.ts`
- `cloud/test/binary.test.ts`
- `cloud/test/wire-fixture.ts`
- `cloud/test/worker.test.ts`
- `cloud/vitest.unit.config.ts`
- `cloud/wrangler.jsonc`
- `cloud/README.md`

`wrangler.jsonc` also defines an isolated `staging` environment with no routes, its own Worker,
Durable Object namespace, and R2 bucket. Production bindings and routes remain unchanged until an
explicit production deployment.

## Reviewer checklist

Review the contract and implementation together; do not approve one side against assumptions about
the other.

### Wire and portable core

- Confirm every frame remains at most 1,024 bytes by protocol and 768 bytes in the UNO profile.
- Confirm the 64-byte header, CRC32C, payload versioning, reserved bits, and exact 48-byte ACK match
  [`alloy-device-wire-v1.md`](alloy-device-wire-v1.md) and the TypeScript fixtures.
- Confirm retry sends the exact retained bytes and sequence number.
- Confirm an exact duplicate is accepted as duplicate, while the same sequence with different bytes
  is a conflict and never overwrites the winner.
- Confirm the six-slot journal, control/GAP reserve, terminal END boundary, sequence exhaustion,
  corruption handling, and tier-3 backpressure tests remain truthful.
- Confirm no allocation symbol enters the RA4M1 core objects.

### UNO adapter

- Capture must contain only fixed-memory setters/commit and `micros()` bookkeeping. Board I/O occurs
  before `sample()`; no `analogRead()`, network, filesystem, allocation, or lock wait belongs inside
  capture.
- Check SCE random run IDs fail closed, the 2^31-microsecond polling bound, DHCP/reconnect/backoff,
  bounded HTTP parsing, exact ACK validation, and retry-state transitions.
- Default TLS must delegate to WiFiS3's verified public trust bundle. Custom CA transport must include
  the terminating NUL, retain hostname verification, revalidate on each new socket, and never fall
  back to an insecure/default mode after failure.
- Keep `tls_connect_timeout_ms` within the RA/WiFiS3 10,000 ms response ceiling.
- Keep the documented short-run limitation: END before the first ACK/SNTP anchor can yield a
  monotonic-only mission.
- Check the final linker RAM totals, not `mallinfo()`, as the memory gate.

### Worker and Durable Object

- `/v1/chunk`, `/v1/meta`, and `/v1/end` must retain their current wire behavior.
- `/v2/frame` must bounded-read actual stream bytes even when `Content-Length` is absent or false,
  then validate magic/version/type/flags/declared size/CRC/payload/identity before durable state.
- Semantic validation must precede R2 writes. Frame row, schema/anchor registry, and session state
  must commit in one SQLite transaction after a content-addressed R2 write.
- The alarm and frame handler must share the same per-DO serialization tail.
- Confirm declaration ordering, schema revision immutability, anchor/sample ordering, u64 projection
  checks, GAP/END counters, reserved terminal sequence values, credential clearing after finalization
  failures, and resume semantics.
- Confirm binary finalization reads bounded frames in deterministic order and emits typed schemas,
  clock anchors, gaps, loss counters, completion state, and mission metadata.
- Preserve the honest bound: ingress and per-frame replay are bounded, but the final MCAP and Mesh
  PUT still use whole-session `MemoryWritable`.
- Preserve the auth truth: the bearer is an Alloy data API key. Device/run identity is
  self-asserted consistency data, not enrolled hardware identity or path-scoped device auth.

## Re-run the complete gate on the isolated branch

Use the repository's installed/pinned dependencies first. Do not combine a Wrangler or Arduino core
upgrade with this release.

```sh
cd /path/to/isolated/alloy-logger-arduino
git diff --check
make -C test/portable test

cd cloud
npm ci
npm test
npm run test:workers
npm run typecheck
./node_modules/.bin/wrangler deploy --dry-run --strict --outdir /tmp/alloylogger-worker-dry-run
```

Compile all five examples from the repository root:

```sh
cd /path/to/isolated/alloy-logger-arduino
arduino-cli compile --warnings all --fqbn arduino:renesas_uno:unor4wifi --library . examples/UnoR4Starter
arduino-cli compile --warnings all --fqbn arduino:renesas_uno:unor4wifi --library . examples/UnoR4Telemetry
arduino-cli compile --warnings all --fqbn esp32:esp32:esp32 --library . examples/AutoCapture
arduino-cli compile --warnings all --fqbn esp32:esp32:esp32 --library . examples/BasicSensor
arduino-cli compile --warnings all --fqbn esp32:esp32:esp32 --library . examples/SelfBalancingRobot
```

The host sanitizer gate does not prove the RA4M1 objects are allocation-free. On the verified Mac,
compile the portable sources with the installed Arduino ARM compiler and reject allocator symbols:

```sh
set -euo pipefail
cd /path/to/isolated/alloy-logger-arduino
ALLOY_ARM_BIN=/Users/hughp/Library/Arduino15/packages/arduino/tools/arm-none-eabi-gcc/7-2017q4/bin
ALLOY_ARM_GATE_DIR="$(mktemp -d /tmp/alloy-device-arm-gate.XXXXXX)"
case "$ALLOY_ARM_GATE_DIR" in
  /tmp/alloy-device-arm-gate.*) ;;
  *) echo "unexpected ARM gate directory" >&2; exit 1 ;;
esac
trap 'rm -r -- "$ALLOY_ARM_GATE_DIR"' EXIT
ALLOY_ARM_FLAGS=(
  -std=gnu++11 -mcpu=cortex-m4 -mthumb -Os
  -ffunction-sections -fdata-sections -fno-exceptions -fno-rtti
  -Wall -Wextra -Werror -Isrc
)
"$ALLOY_ARM_BIN/arm-none-eabi-g++" "${ALLOY_ARM_FLAGS[@]}" -c src/alloy/device/protocol.cpp -o "$ALLOY_ARM_GATE_DIR/protocol.o"
"$ALLOY_ARM_BIN/arm-none-eabi-g++" "${ALLOY_ARM_FLAGS[@]}" -c src/alloy/device/core.cpp -o "$ALLOY_ARM_GATE_DIR/core.o"
"$ALLOY_ARM_BIN/arm-none-eabi-nm" -u "$ALLOY_ARM_GATE_DIR/protocol.o" "$ALLOY_ARM_GATE_DIR/core.o" > "$ALLOY_ARM_GATE_DIR/undefined-symbols.txt"
ALLOY_ALLOCATOR_SCAN_STATUS=0
rg '(_Zn[aw]|_Zd[la]|[[:space:]]_?(malloc|calloc|realloc|free)(_r)?$)' "$ALLOY_ARM_GATE_DIR/undefined-symbols.txt" || ALLOY_ALLOCATOR_SCAN_STATUS=$?
case "$ALLOY_ALLOCATOR_SCAN_STATUS" in
  0) echo "allocator symbol found in portable RA4M1 objects" >&2; exit 1 ;;
  1) ;;
  *) echo "allocator scan failed" >&2; exit "$ALLOY_ALLOCATOR_SCAN_STATUS" ;;
esac
"$ALLOY_ARM_BIN/arm-none-eabi-size" "$ALLOY_ARM_GATE_DIR/protocol.o" "$ALLOY_ARM_GATE_DIR/core.o"
```

On another machine, resolve the equivalent compiler installed by the Arduino Renesas UNO core; do
not silently substitute a host compiler. Record object sizes as well as the symbol result.

The final dirty-tree reference gate passed:

- portable core: 16/16 under C++11 ASan/UBSan;
- Worker unit tests: 30/30 including the pre-existing mission test;
- Worker-runtime tests: 34/34;
- TypeScript typecheck;
- UNO Starter: 88,688 bytes flash, 14,704 bytes global RAM;
- UNO Telemetry: 88,776 bytes flash, 14,704 bytes global RAM;
- all three legacy ESP32 examples; and
- `git diff --check`.

If the mission patch is intentionally omitted, the unit-test count can be one lower; require all
discovered tests to pass rather than forcing the old count.

The handoff dry-run used Wrangler 4.114.0 and produced a 237.40 KiB upload (46.20 KiB gzip) with
exactly `SESSION_DO`, `STAGING`, `ALLOY_DATA_URL`, and `INACTIVITY_MS` bindings. Wrangler reported a
newer CLI version; do not upgrade it in this release without a separate lockfile diff and full
rerun.

## Commit and PR plan

Recommended logical commits on the isolated branch:

1. portable wire protocol, core, contract, and host tests;
2. UNO R4 adapter, ESP32 compile guard, examples, library metadata, and hardware docs;
3. Worker `/v2/frame`, binary Durable Object/MCAP path, tests, and cloud docs; and
4. this operational handoff, if it should remain in the repository.

Release policy is now explicit: `library.properties` is `0.5.0`, points to the Alloy Robotics
repository, and declares both supported architectures. `README.md` preserves the existing ESP32
API while documenting UNO R4 as a separate cooperative adapter and Alloy Device Wire as its binary
transport.

For every commit:

- confirm `git diff --cached --name-only` is a subset of the allowlist;
- confirm both secret-placeholder headers contain only the expected empty definitions without
  printing their contents;
- run a redacted, filename-only staged credential scan before displaying any patch;
- only after those checks, inspect `git diff --cached --check` and `git diff --cached`; and
- leave all `demo/**`, `.dev.vars*`, `.env*`, build products, `.wrangler/`, downloaded MCAPs, and
  `/private/tmp` material unstaged.

Open the PR from the isolated `codex/` branch against the freshly confirmed target branch. Include
the gates above, the six physical scenarios, the known limitations below, and the exact staging and
production deployment state at the time the PR is opened.

## Deployment plan

### 1. Inspect live state before any write

Use only the ingest project under `cloud/`. The repository root has a different site Worker and a
root-level deploy would target the wrong service. From `cloud/`, authenticate without exposing
tokens and record the live Worker version/config:

```sh
./node_modules/.bin/wrangler whoami
./node_modules/.bin/wrangler deployments status --json
./node_modules/.bin/wrangler secret list
./node_modules/.bin/wrangler r2 bucket info alloylogger-staging
./node_modules/.bin/wrangler r2 bucket lifecycle list alloylogger-staging
```

Record the version ID currently receiving production traffic from `deployments status`, not merely
the newest uploaded version. Optionally inspect that exact ID with `wrangler versions view <id>
--json`. Compare live variables, routes, bindings, and Durable Object migration state with
`wrangler.jsonc`. Do not print secret values. The Worker does not require a new Alloy secret:
clients present their Alloy data API key as the request bearer, and the Worker exchanges it for an
upload session. A code deploy preserves Worker secrets, but Wrangler can replace dashboard-managed
plain variables; omit `--keep-vars` only after confirming the checked-in config is the intended
source of truth.

The config does not pin an `account_id`, so confirm `whoami` resolves the intended Alloy Cloudflare
account. It currently targets live `ingest.alloylogger.com`, keeps the existing
`alloylogger-cloud.alloylogger.workers.dev` alias enabled, binds `SessionDO`, and binds the
production `alloylogger-staging` R2 bucket. Verify that bucket still has its intended seven-day
lifecycle; cleanup failures rely on external lifecycle expiry as the last orphan bound. A top-level
`wrangler deploy` creates a version and immediately sends production traffic to it. Do not use it
as the first deployment.

### 2. Add and prove an isolated staging environment

The checked-in `env.staging` defines:

- a distinct Worker name/`workers.dev` endpoint and no production custom-domain route;
- its own Durable Object namespace and required initial SQLite-class migration;
- its own R2 staging bucket;
- the same `ALLOY_DATA_URL` and `INACTIVITY_MS` values; and
- initially `DRY_RUN=1` if the first smoke must not create a real Mesh object.

Bindings and `vars` are not inherited automatically into Wrangler environments, so specify and
validate each one. Resource creation is external state: resolve exact account, names, and retention
policy before creating them. Run the full tests and a strict dry run after the config change, then
deploy only the named environment:

```sh
./node_modules/.bin/wrangler deploy --env staging --strict --message "stage Alloy Device Wire v1"
```

Staging acceptance:

- `GET /v1/health` returns `200 {"ok":true}`;
- a controlled legacy `/v1` mission still reaches finalization;
- missing auth and malformed/oversized v2 requests fail with the documented status/ACK and create
  no R2/SQLite state;
- a unique valid v2 BEGIN/CAPABILITIES/SCHEMA/ANCHOR/SAMPLES/END run receives exact ACKs;
- an exact retry is `Duplicate`, and a changed body at the same sequence is a non-overwriting
  conflict;
- the alarm emits `binary finalize complete device=... run=... mcapBytes=...` only after the Mesh
  PUT and terminal state;
- the resulting MCAP can be listed, downloaded, and inspected with the expected typed fields,
  timestamps, counters, and completion metadata; and
- legacy and v2 data never mix in one session.

Also run an inactivity case without END and wait beyond the configured 120,000 ms so alarm-driven
incomplete finalization is proven in the deployed runtime.

For a real finalization smoke, remove `DRY_RUN` only in the staging environment and use a unique test
Mesh prefix. Obtain the API key through the approved secret store at runtime; never paste it into a
command, tracked header, transcript, or capture. Use an outside-repository sketch or ephemeral
sender. END ACK proves device-frame acceptance, not asynchronous Mesh completion—wait for the
credential-free completion log and then verify the object.

### 3. Production deployment

Deploy cloud support before distributing/flashing v2 firmware beyond the single test board. After
staging and PR approval:

1. record the old production version ID and start a credential-redacted log tail;
2. rerun the strict dry-run bundle from the exact reviewed commit;
3. deploy with `--strict` and a descriptive version message;
4. immediately check `/v1/health` through both the production custom domain and existing
   `workers.dev` alias, then exercise one controlled legacy request path;
5. send one unique complete v2 mission and wait for asynchronous finalization;
6. download and inspect its MCAP from Mesh;
7. monitor Worker errors, Durable Object alarms, R2 cleanup, authentication failures, and latency;
   and
8. record deployed version ID, UTC time, routes, smoke run ID/path, MCAP result, and any SQL
   readiness lag here without credentials.

The production command is intentionally not made copy-and-paste automatic in this document because
it targets the live custom domain. Run the reviewed equivalent of:

```sh
./node_modules/.bin/wrangler deploy --strict --message "add Alloy Device Wire v1 ingest"
```

Do not use `--keep-vars` or omit it by habit; make that choice from the live/config comparison. Do
not add a Worker API-key secret—the protocol intentionally forwards the client's Alloy bearer only
inside the authenticated request lifecycle.

### 4. Rollback

If health, legacy traffic, v2 ACKs, finalization, or Mesh verification fails, stop firmware rollout
and roll back to the exact version recorded before deployment:

```sh
./node_modules/.bin/wrangler rollback <RECORDED_VERSION_ID> --message "rollback Alloy Device Wire v1"
```

Rollback changes active Worker code; it does not delete R2 objects or undo Durable Object SQLite
tables/data. The new production schema is additive within the existing `SessionDO` class and adds no
new top-level production migration tag, but verify any in-flight v2 run separately. Devices retain
unacknowledged frames only within their six-slot volatile journal, so keep the v2 fleet limited to
the smoke device until the cloud version is stable.

## Known limitations that must remain explicit

- UNO tier 1 is volatile best effort. Reset/power loss discards retained RAM and creates a new run.
- The UNO has six 768-byte journal slots; sustained offline capture can produce explicit sample
  loss/GAP records.
- Ordinary 2.4 GHz open/personal Wi-Fi is supported. Enterprise 802.1X and captive-portal flows are
  not. Bridge-command commas in SSID/password are rejected rather than misparsed.
- NTP is optional. Verified server ACK time anchors ongoing runs, but a run ended before its first
  trusted time response may remain monotonic-only.
- Device `Complete`/RUN_END ACK is not proof of cloud MCAP finalization.
- `/v2/frame` ingress and replay are bounded; final MCAP output is still held whole in memory.
- The existing `/v1` route remains legacy-compatible and does not inherit every new v2 validation
  guarantee.
- Device and run fields are self-asserted. The current Alloy data API key check is not device
  enrollment or hardware identity.
- The Workers test runner could not perform a literal Durable Object eviction after injected R2 I/O;
  crash-boundary tests instead cleared all volatile ingest fields and proved SQLite rehydration and
  retry acceptance. The implementation's R2-then-single-SQLite-transaction ordering remains the
  safety mechanism.
- In the physical gate, Mesh listing/download/replay passed while hosted SQL had not indexed the
  oldest new run after a bounded 180-second poll. Treat SQL Ready as an asynchronous downstream gate,
  not as proof that the device upload failed.
- The current Wrangler compatibility date and CLI version were not upgraded as part of this feature.
  Review upgrades separately rather than combining them with the initial rollout.

## Cleanup and credential state already completed

- Local Worker and LAN TLS proxy stopped; no listeners remained on ports 8787 or 8443.
- The exact temporary Wrangler state containing the local Worker credential and the throwaway local
  TLS private key were deleted and are not recoverable.
- Non-secret body-only frame captures and downloaded MCAP evidence remain under
  `/private/tmp/alloy-e2e-captures.C7moyo`; treat this as ephemeral evidence, not a release input.
- No supplied Wi-Fi or Alloy API credential was found in repository content.
- An unrelated ignored `.dev.vars` predates this work. Do not read, copy, stage, or depend on it.
- The board was reflashed with `.uno-probe/Disconnect`, called `WiFi.end()`, and repeatedly reported
  `ALLOY_UNO_WIFI_DISCONNECTED` over USB.

## Deployment record (complete during release)

- Reviewed commit/PR:
- Public library version/tag decision:
- Staging Worker/version:
- Staging R2/DO resources:
- Staging v1 smoke:
- Staging v2 run and MCAP:
- Previous production version ID:
- New production version ID:
- Production deployment UTC:
- Production v1 health/regression:
- Production v2 smoke run/path:
- Mesh list/download/MCAP verification:
- Hosted SQL Ready time, if applicable:
- Monitoring window/result:
- Rollback exercised or retained version:
- Residual follow-ups:
