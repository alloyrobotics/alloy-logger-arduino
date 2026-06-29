# esp32-robolog

A robot **black-box recorder** for ESP32-class hardware — **no SD card, no laptop**. Logs sensor
*inputs* + actuator *outputs* (IMU, ADC, encoders, motor command setpoints, GPIO/e-stop) on **one
timeline**, writes **JSON-Lines** to on-chip flash (LittleFS) in **rolling chunks**, and uploads each
chunk **directly to Alloy**, then deletes it — so runtime is **unlimited**. Numeric control-loop data
only (no camera/audio): one control tick = one `esp_timer` ns timestamp = everything aligned by
construction, with 50–100× write-bandwidth headroom.

## Status — verified end-to-end on real hardware (2026-06-29)
Classic ESP32 on `/dev/cu.usbserial-120`, no SD card:
- Records → rolls chunks → uploads each to Alloy → deletes. A 40 s run produced **5 chunks, all in
  Alloy Mesh Storage, `dropped=0 chunks_dropped=0`**, no FS errors.
- Upload path: `upload-session` (Bearer key) → SigV4 PutObject → **Cloudflare R2** (path-style, region
  `auto`, `UNSIGNED-PAYLOAD`). The session is cached/reused across chunks (one R2 PUT per chunk).
- Store-and-forward: if WiFi drops, chunks queue on flash (bounded; oldest shed) and flush on reconnect.
  The pending buffer can never overrun the FS (`openNextChunk` sheds oldest if flash is full).

## Files
| File | Role |
|---|---|
| `RoboLog.h` | Logger: channels + field layouts, bounded queue, core-1 JSONL writer, **rolling chunks** + free-space guard, on-change helper |
| `AlloyUploader.h` | Direct Alloy upload: cached `upload-session` + SigV4 R2 PutObject (any `fs::FS`) |
| `ChunkUploader.h` | Background task: drains closed chunks, uploads + deletes, retries with backoff |
| `esp32-robolog.ino` | Control loop → rolling record → chunked upload (LittleFS, unlimited runtime) |
| `upload_smoketest/` | Minimal one-file upload test (proves the MCU→Alloy link) |
| `PLAN.md` | Design, Option 2 (now) → Option 3 (server shim + MCAP, later), deferred items |

## Setup / flash
```bash
cp secrets.h.example secrets.h     # fill WiFi + Alloy key; secrets.h is gitignored
arduino-cli core install esp32:esp32
arduino-cli lib install ArduinoJson
arduino-cli compile -u -p <PORT> --fqbn esp32:esp32:esp32 .
```
Serial @115200. Chunks appear under `uploads/sdk-uploads/<MESH_PATH>/c_<session>_<seq>.jsonl` in Alloy.

## Tuning
- `LOG_HZ` — recorder rate (demo 50 Hz). Sustained rate is bounded by upload throughput (~one R2 PUT
  per chunk over WiFi); if the uplink can't keep up, oldest pending chunks are shed (counted), recording
  never stalls. ESP32-S3 / better WiFi lifts this.
- `CHUNK_MS` / `CHUNK_BYTES` — roll cadence. `CHUNK_QDEPTH` — pending-chunk buffer (× chunk size must
  stay under the LittleFS partition, ~1.4 MB).
- `RUN_SECONDS` — demo length; **set 0 to run forever**.

## Alloy direct-upload protocol (confirmed)
1. `POST {ALLOY_DATA_URL}/mesh/storage/upload-session`, `Authorization: Bearer {ALLOY_API_KEY}`,
   body `{"path":"<folder>","ttl_seconds":900}` → `{bucket, endpoint_url, region, prefix,
   credentials{access_key_id, secret_access_key, session_token}}`.
2. **S3 PutObject** `{endpoint_url}/{bucket}/{prefix}{file}` SigV4-signed with the temp creds
   (`x-amz-security-token`), `x-amz-content-sha256: UNSIGNED-PAYLOAD`. Needs an SNTP UTC clock.

`.jsonl` ingests natively into Alloy's queryable tables (SQL/DuckDB).

## Roadmap → Option 3 (live streaming)
Stream frames to a small server-side shim co-located with Alloy that assembles **MCAP** (rich
Replay/Inspect) and uploads via the Python SDK — also removes SigV4/keys from the MCU. The
channel/field-layout model here carries over unchanged; it's a transport swap, not a rewrite.
