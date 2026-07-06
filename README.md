# AlloyLogger

Stream Arduino sensor & telemetry data **straight to [Alloy](https://usealloy.ai)** from an ESP32 —
in about ten lines. You log `name → value` pairs at the call site; the library RAM-buffers them and
uploads to Alloy in the background. **Every power-on lands in Alloy as one MCAP mission**: replay it,
scrub it, query it with SQL, ask about it over MCP. **No SD card, no flash wear, never blocks your loop.**

You usually don't declare anything: Alloy's AI reasons over your tag + field names + values (a
`heading` ranging 0–360 under a `bno055` tag → it's a magnetic heading). Optionally `describe()` a
field to hand Alloy units/ranges for even sharper context.

> Verified end-to-end on real hardware: an ESP32 streaming `env`/`battery` telemetry → a `meta.json`
> semantics sidecar + CSV chunks land in Alloy Mesh Storage, `uploaded` climbing, `dropped=0`.

```cpp
#include <AlloyLogger.h>
AlloyLogger alloy;

void setup() {
  alloy.wifi("ssid", "pass");                 // optional — omit if already connected
  alloy.begin("ALLOY_API_KEY", "robots/sbr"); // starts background upload
}

void loop() {
  alloy.log("bno055")
       .set("heading", heading)
       .set("pitch",   pitch)
       .set("roll",    roll);                  // commits at the ';'
  alloy.log("battery", volts);                 // single value
}
```

---

## Why it's nice

- **Self-documenting calls.** The field name sits next to its value — nothing to declare, nothing to
  keep in sync, no positional args to get wrong.
- **Non-blocking.** `log()` formats one compact CSV row on the caller's stack (one `%.6g` per
  field) and appends it to a RAM buffer under a short mutex — tens of microseconds, no network,
  no filesystem, no allocation. A background task on **core 0** does the TLS upload, so a control
  loop on core 1 is never disturbed.
- **Reliable by default.** RAM-buffered with **store-and-forward** — if WiFi drops, buffers queue and
  flush on reconnect; if the uplink can't keep up, the oldest buffer is shed (counted), never a crash.
- **Zero flash wear.** Nothing touches the filesystem, so it coexists with OTA / `min_spiffs` layouts.
- **Alloy-native.** Each run becomes one indexed `.mcap` in your mesh: Replay/Inspect, mission
  summaries, and SQL all work out of the box, plus a one-time semantics sidecar for Alloy AI.

---

## Install

**Arduino IDE:** Sketch → Include Library → Add .ZIP Library (or clone into `~/Arduino/libraries/`).
Depends on **ArduinoJson** (Library Manager).

**arduino-cli / PlatformIO:**
```bash
arduino-cli lib install ArduinoJson
# clone this repo into your libraries folder, or for a one-off build:
arduino-cli compile --fqbn esp32:esp32:esp32 --library /path/to/AlloyLogger your_sketch
```

You need an Alloy account + a data-API key (Dashboard → Mesh Storage → API key). Keep the key in
a gitignored `secrets.h`, not in the sketch — see [Security](#security) for what it can do.

---

## API

```cpp
AlloyLogger alloy;
```

**Config (all optional, before `begin`)** — each returns `*this` so you can chain:
| Call | Purpose | Default |
|---|---|---|
| `alloy.wifi(ssid, pass)` | Connect WiFi. Omit if your sketch already connected. | — |
| `alloy.device(id, firmware)` | Device id + firmware tag (into `meta.json`). | id = sketch filename (`MyRobot.ino` → `MyRobot`) |
| `alloy.buffers(count, bytes)` | RAM buffer pool. Keep count above your channel count, and the total well under half the free heap (a verified TLS handshake needs ~60 KB headroom). | `4 × 12 KB` |
| `alloy.describe(channel, field, unit, min, max, about)` | Richer semantics for Alloy AI. | — |
| `alloy.insecure()` | Skip TLS verification (TLS-intercepting proxies etc.). | verify via Mozilla roots |
| `alloy.direct()` | Legacy transport: SigV4 CSV chunks straight to your mesh, no MCAP assembly. | cloud |
| `alloy.finalizeAfter(sec)` | How long after the last data the cloud declares the run over and finalizes its `.mcap`. | 2 min (server; clamped 30 s – 30 min) |
| `alloy.ingestUrl(url)` | Override the AlloyLogger Cloud endpoint. | `https://ingest.alloylogger.com` |

**Start:**
```cpp
alloy.begin(apiKey, meshPath);   // meshPath e.g. "robots/sbr"; optional 3rd arg = data URL
```

**Log:**
```cpp
alloy.log("channel").set("a", x).set("b", y);   // multi-field, commits at end of statement
alloy.log("channel", value);                     // single value (field name "value")
```
`set()` takes `float` / `int` / `double` / `bool`. Values are stored as `float` (see
[Limits & notes](#limits--notes)).

**Auto-capture (set-and-forget)** — register *once* and the library captures for you in the
background, with **no code in `loop()`**. When something unexpected happens, the data is
already there — no reflash to add a probe, no serial monitor:
| Call | Streams | Channel |
|---|---|---|
| `alloy.scope()` | **every GPIO your sketch uses** — auto-discovered from the chip's own pin config (outputs, inputs with pulls, I2C/SPI/PWM peripherals), change-driven: `gpioN` level + `gpioN_hz` toggle frequency. Fast pins (SPI clocks, steppers at speed) are summarized as frequency. Also enables heap/RSSI/uptime. | `io` + `sys` |
| `alloy.watchAnalog(pin, "name")` | an analog pin (`analogRead`) | `adc` |
| `alloy.watch("chan", "field", fn)` | any variable/expr via a captureless `float(*)()` | `chan` |
| `alloy.sampleEvery(ms)` | sampler period (default `100` = 10 Hz) | — |

```cpp
float g_pitch;  float readPitch() { return g_pitch; }   // expose a variable

alloy.scope();                              // the software oscilloscope: every configured pin
alloy.watchAnalog(34, "batt_raw");          // ADC
alloy.watch("imu", "pitch", readPitch);     // your own variable
alloy.begin(ALLOY_KEY, "demos/auto");       // register before begin()
```
`scope()` emits an `io` row only when a pin changes (plus a heartbeat every few seconds), so a
quiet board costs almost nothing. Pins configured *after* `begin()` are picked up by a periodic
re-scan. `gpioN_hz` is a measured floor — MHz buses read as "very fast", not exact. Watched fields
sharing a channel are written as one aligned row per tick — same CSV tables, same `describe()`
semantics. Mix freely with explicit `log()` calls.

**End of run (optional):**
```cpp
alloy.end();   // seal + drain + finalize the mission .mcap now
```
Without it, the run finalizes automatically ~2 minutes after the last data (tune with
`finalizeAfter()`; power loss is detected server-side, which is the only place it can be). `end()`
just makes the mission appear immediately, e.g. on a kill switch or at the end of a scripted test.

**Stats:** `alloy.uploaded()`, `alloy.failed()`, `alloy.dropped()` (buffers shed under backpressure),
`alloy.stale()` (chunks refused because the run had already finalized).

---

## How it gets to Alloy

The device streams compact **per-channel CSV chunks**: a one-line header (`t_ns` + your field
names), then bare value rows, wall-clock-timestamped so channels align with no extra math:
```csv
t_ns,temp_c,humidity
1782715694000000000,22.4,51.2
1782715695000000000,22.5,51.1
```
The header makes each chunk **self-describing** — the schema travels with the data, nothing to
keep in sync with your firmware — and dropping per-row JSON keys roughly halves the bytes on the
wire. (That's efficient *versus JSON*, not versus binary: values are still text-formatted at the
call site. A binary framing is on the [roadmap](#roadmap).) One channel = one consistent schema.

**Why CSV on the wire, MCAP at rest?** Text CSV is a deliberate v1 choice for the device side:
you can eyeball a chunk over the serial monitor, replay one with `curl`, and a run that dies
mid-chunk still parses up to the last complete row. Nothing downstream reads it, though — the
cloud service assembles every run into a chunked, indexed **MCAP** with JSON-Schema channels, so
replay, SQL, and tooling never touch CSV.

Chunks go to **AlloyLogger Cloud** (`ingest.alloylogger.com`) over plain keep-alive HTTPS. The
service stages them and, when the run ends (`alloy.end()` or ~2 min of silence), assembles **one
indexed `.mcap`** and uploads it into *your* Alloy mesh at `<meshPath>/<session>/`, together with
the **`meta.json`** semantics sidecar built from your `describe()` calls:
```json
{ "device":"sbr-01", "firmware":"fw16", "session":"2026-06-29T06:48:14Z",
  "fields":[ {"channel":"env","name":"temp_c","unit":"degC","min":-40,"max":125,"about":"ambient temperature"} ] }
```
Every power-on = one mission in Alloy: replayable, inspectable, SQL-queryable, visible to
`list_missions` and the rest of the Alloy MCP surface.

**Privacy note:** in cloud mode your telemetry and API key transit the AlloyLogger Cloud service.
Chunks are staged only until the run's `.mcap` is uploaded, and the key is held only for the
session's lifetime, then purged. If you'd rather not have a middleman, `alloy.direct()` uploads
SigV4-signed CSV chunks straight from the device to your mesh (queryable tables, but no per-run
MCAP, replay, or mission view).

---

## Examples

- **[BasicSensor](examples/BasicSensor)** — stream a sensor in ~10 lines.
- **[AutoCapture](examples/AutoCapture)** — set-and-forget: `scope()` every pin + `watch()` variables, nothing in `loop()`.
- **[SelfBalancingRobot](examples/SelfBalancingRobot)** — add streaming to a 100 Hz control loop
  without disturbing real-time stepping (the pattern for a robot that already manages WiFi).

---

## Limits & notes

- **Sustained rate is bounded by upload throughput** (~one R2 PUT per buffer over WiFi). A few hundred
  records/sec is comfortable; far higher sheds oldest buffers (counted in `dropped()`). Tune with
  `buffers()`, or use an ESP32-S3 / better WiFi.
- **Values are `float`** (~7 significant digits). `set()` silently narrows `double`; `int` and
  `bool` are converted. Timestamps are exempt — `t_ns` is a full-width integer column.
- **`log()` is not ISR-safe.** It takes a FreeRTOS mutex — call it from tasks only, never from an
  interrupt handler. (`scope()`'s edge counting runs in its own 3-instruction IRAM ISR; it never
  calls `log()`.)
- **The library's tasks run on core 0** (uploader at priority 4, sampler at 3). Arduino `loop()`
  on core 1 is unaffected; if your sketch pins its own work to core 0, keep it below priority 4 or
  expect brief preemption during TLS writes.
- **A real UTC clock is required** (timestamps + session ids; SigV4 in direct mode) — the library
  runs SNTP automatically. Records logged
  before the first sync are stamped with a boot-relative clock and rebased to wall-clock time
  in-buffer once SNTP lands, so nothing is lost or mis-timed.
- **TLS is verified by default** against the ESP32 core's embedded Mozilla root CA bundle (no extra
  flash shipped by this library). `alloy.insecure()` opts out for networks that intercept TLS.
- ESP32 / ESP32-S3 only (uses WiFi + mbedTLS).

## Security

- **Know what the key can do.** The key you flash is a long-lived Alloy **data-API key**: it can
  read, write, and SQL-query your whole org's mesh, not just this device's path. Treat a leaked
  key as a leak of your org's data plane, not of one robot's telemetry.
- **The device is not a vault.** ESP32 flash is dumpable — anyone with the board (or a sketch you
  committed) has the key. Keep it in a gitignored `secrets.h`, give each device its own key, and
  rotate on any suspicion.
- **What the cloud holds.** In cloud mode the key rides along with each request; the service keeps
  it only for the session's lifetime and purges it at finalize. The temporary upload credentials it
  derives expire after 900 s — but that TTL covers the *derived* credentials, not your key. No raw
  storage (R2) credentials ever reach the device.
- Fine for a hobby rig today. Before putting this on a real fleet you want the write-only,
  path-scoped ingest keys on the [roadmap](#roadmap).

## Roadmap

- **Binary wire framing.** Replace CSV rows with a compact binary encoding — takes the remaining
  per-field text formatting off the hot path and makes "efficient" literal rather than
  efficient-versus-JSON.
- **Scoped ingest keys.** Write-only, path-scoped per-device keys, so a key pulled off a board
  can't read — or touch — anything else in the org.

## License

MIT — see [LICENSE](LICENSE).
