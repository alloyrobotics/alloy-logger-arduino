# AlloyLogger Cloud local development

From this directory:

```sh
npm ci
npm run dev -- --local
```

`wrangler.jsonc` supplies the `SESSION_DO` Durable Object, local `STAGING` R2 binding,
`ALLOY_DATA_URL`, and `INACTIVITY_MS`. Binary requests carry the Alloy data API key as their Bearer
credential; the Worker has no separate API-key secret. For a real mesh finalization,
`ALLOY_DATA_URL` must be reachable and `DRY_RUN` must be unset. Setting `DRY_RUN=1` still performs
request authentication against the real Alloy API, but skips the finalization upload-session mint
and final Mesh PUT after the MCAP is assembled.

`POST /v2/frame` ACKs only frame acceptance. A contiguous `RUN_END` is staged and ACKed, then
finalization runs asynchronously from the Durable Object alarm. If preceding sequences are missing,
the run remains receivable until they arrive, a GAP explicitly accounts for them, or inactivity
fires. Successful completion is observable in the tombstone and this credential-free log line:

```text
binary finalize complete device=<device> run=<32-hex-run> mcapBytes=<bytes>
```

The local R2/SQLite state is managed by Wrangler. `--remote` is not required for a real outbound
finalization and should not be used merely to test local ingest.
