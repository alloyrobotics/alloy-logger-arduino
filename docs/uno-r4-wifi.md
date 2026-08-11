# AlloyLogger on Arduino UNO R4 WiFi

UNO R4 support is a separate adapter, not a port of the ESP32/FreeRTOS logger. Include
`<AlloyUnoR4.h>` and call `poll()` from the sketch. The portable binary core owns schemas, samples,
the six-slot journal, CRC32C, sequencing, and exact ACK validation; the adapter owns only RA4M1
entropy/time, WiFiS3, verified TLS/HTTP, diagnostics, and the LED matrix. The application performs
explicit board I/O before handing typed values to the capture path.

The current profile is tier 1 (volatile best effort). Reset or power loss discards its RAM journal
and starts a new random run. It does not claim persistent recovery, loss-intolerant backpressure,
OTA, or a trustworthy runtime free-memory measurement.

## Toolchain and examples

Verified without uploading a board:

- FQBN: `arduino:renesas_uno:unor4wifi`
- Arduino CLI 1.5.0
- Arduino Renesas UNO core 1.6.0
- bundled WiFiS3 and Arduino LED Matrix libraries
- connectivity-module firmware 0.6.0 on the reference board

Compile either example:

```sh
arduino-cli compile \
  --fqbn arduino:renesas_uno:unor4wifi \
  --library /path/to/alloy-logger-arduino \
  /path/to/alloy-logger-arduino/examples/UnoR4Starter

arduino-cli compile \
  --fqbn arduino:renesas_uno:unor4wifi \
  --library /path/to/alloy-logger-arduino \
  /path/to/alloy-logger-arduino/examples/UnoR4Telemetry
```

`UnoR4Starter` captures a finite run, retries `end()` if the journal is full, and continues polling
until the exact RUN_END frame is acknowledged. `UnoR4Telemetry` demonstrates explicit analog and
digital reads, cached RSSI, uptime, adapter state, and a `scheduled_tick` that jumps when a blocking
cooperative network call causes a 100 ms application period to be missed. It deliberately captures
one row rather than running a catch-up loop.

The checked-in `arduino_secrets.h` files contain empty compile-only placeholders. Supply real SSID,
password, and API-key values locally and do not commit them. `Config` stores borrowed pointers only:
the adapter does not copy credentials or an optional CA into its journal or write them to flash/NVM.
The pointees must remain valid and unchanged for every reconnect. A sketch that uses string literals
still chooses to put those literals in its own firmware image.

## Minimal API

```cpp
#include <AlloyUnoR4.h>

AlloyUnoR4 logger;
const AlloyUnoR4Field fields[] = {
    {0, alloy::device::v1::FIELD_U16, "adc_raw", "count"},
    {1, alloy::device::v1::FIELD_BOOL, "switch_high", ""},
};

void setup() {
  pinMode(2, INPUT_PULLUP);

  AlloyUnoR4Config config;
  config.ssid = SECRET_WIFI_SSID;
  config.password = SECRET_WIFI_PASSWORD;
  config.api_key = SECRET_ALLOY_API_KEY;
  config.device_id = "uno-r4-01";
  config.mesh_path = "robots/bench";
  config.firmware = "fw1";
  config.mission = "adc-test";
  config.diagnostics = &Serial;  // optional; messages never include credentials

  logger.begin(config);
  logger.declareSchema(1, 1, "board_io", fields, 2);
}

void loop() {
  logger.poll();
  const uint16_t pot = static_cast<uint16_t>(analogRead(A0));
  const bool button = digitalRead(2) != LOW;
  AlloyUnoR4Sample row = logger.sample(1, 1);
  AlloyUnoR4CommitResult result =
      row.setU16(0, pot).setBool(1, button).commit();
  (void)result;
}
```

Field IDs must be contiguous from zero and setters must match declared types. Read explicitly
configured pins before calling `sample()`, then use typed setters such as `setU16()` and `setBool()`.
The logger does not configure, discover, or read GPIO and does not scan peripheral registers.

`sample()` timestamps immediately and returns a fixed stack builder. Typed setters and explicit
`commit()` perform fixed-capacity memory operations only. The builder destructor intentionally does
nothing. No capture method performs allocation, text formatting, networking, filesystem work, or a
blocking lock. Do not retain a builder across a call to `poll()`, and do not call the facade from an
ISR or concurrently from multiple contexts.

Commit results are `Accepted`, `WouldBlock`, `Invalid`, and `Faulted`. On this tier-1 profile,
`WouldBlock` means the row was not accepted and may have been dropped newest; check `stats()` for
cumulative drops/backpressure. There is no hidden retry of a capture call.

## Cooperative networking and TLS

`poll()` owns association, DHCP/DNS checks, cached RSSI, time anchors, TLS, HTTP, ACK parsing, and
retry. At most one exact journal frame is in flight. A failed attempt retains those byte-identical
bytes and retries exponentially, capped at 30 seconds. A slot is reclaimed only after a 48-byte ACK
passes magic/version/length/CRC, run ID, frame sequence, and echoed request-CRC checks. A bare HTTP
2xx never frees data. HTTP 401/403 enters `AuthBlocked`; terminal conflicts enter `Stale` or
`Faulted` without silently starting another run.

WiFiS3 association and TLS-connect APIs are synchronous. They run only inside `poll()`, with the
configured bounds, but a particular `poll()` call can still occupy the cooperative sketch while the
coprocessor connects. Keep control-critical work outside that call or schedule it with that bound in
mind. `tls_connect_timeout_ms` accepts 1–10,000 ms (8,000 ms by default). Values above 10,000 ms are
rejected because the RA-side WiFiS3 modem control path has a hard 10-second response limit; allowing
the coprocessor operation to outlive that limit can desynchronize the bridge. Response consumption
itself is incremental and bounded per poll.

Production defaults are verified TLS to `ingest.alloylogger.com:443` and `POST /v2/frame`, using
WiFiS3's default CA bundle. This is the portable choice for public ingest origins. There is no
insecure mode. `host`, `port`, and `request_path` may be overridden, but the configured host must
match the certificate SAN and the path must be a query-free HTTP origin-form path.

Set the optional borrowed `config.ca_cert` pointer to a PEM root (or concatenated PEM roots) only
for a private origin that is not in the default bundle. A custom value replaces the default trust
bundle for that connection; leave it null for normal production use. The PEM must start with
`-----BEGIN CERTIFICATE-----`, end with `-----END CERTIFICATE-----` apart from trailing whitespace,
and contain at most 4,095 bytes. `begin()` validates only this nonempty, bounded PEM envelope; an
empty, oversized, or incorrectly delimited envelope returns `InvalidConfig`. It does not implement a
DER or base64 parser. Invalid certificate/base64 content inside an accepted envelope fails closed at
the verified TLS handshake and enters the normal retained-frame retry path. It never falls back to
the default bundle and never acknowledges or frees telemetry.

Connectivity firmware 0.6.0 forwards custom-root bytes to an ESP32 TLS API that expects a
NUL-terminated C string, while stock WiFiS3 omits that terminator. The adapter's custom-root path
works around only that bridge defect by including the existing terminating NUL in the bounded AT
passthrough. It retains certificate-chain and hostname verification. On the reference board, a
matching private root and hostname connected, the same root with a wrong certificate hostname was
rejected, and the private chain remained rejected when using the default bundle. No certificate
bytes are copied into the Alloy journal or persisted by the adapter.

The adapter accepts ordinary 2.4 GHz open or personal WPA2/WPA3 networks supported by WiFiS3. It
does not claim enterprise authentication or captive-portal handling. The current safe adapter input
profile accepts printable-ASCII SSIDs/passwords and rejects commas because the WiFiS3 bridge command
layer sends those values as unescaped comma-delimited arguments. WPA personal passwords must be
8–63 printable characters or 64 hexadecimal digits.

Mesh paths match `[A-Za-z0-9_/-]{1,128}` and are supplied without a leading or trailing slash.
Device IDs match `[A-Za-z0-9_-]{1,32}`. Diagnostics report connection/state/counter events but never
SSID, password, bearer key, mesh path, device ID, or certificate contents.

## Time behavior

Capture always uses the RA4M1 monotonic `micros()` counter, extended by the portable core. Call
`poll()` or commit a sample at least once per `2^31` microseconds (about 35.8 minutes), so the core
can distinguish a wrap from a regression.

UTC never gates capture or upload. While a run is still capturing, a nonzero `WiFi.getTime()`
appends an SNTP/synchronized anchor; old samples are not rewritten. The reference network provided
DHCP, DNS, and verified HTTPS but `WiFi.getTime()` remained zero. For that normal failure mode, the
adapter parses decimal
`X-Alloy-Server-UTC-Ns` only from the verified-TLS ingest origin and only after the accompanying ACK
fully validates. It appends an authenticated-host/approximate anchor at the local request/response
midpoint with uncertainty of at least measured RTT plus the server clock's 1 ms resolution. A later
SNTP anchor is appended and becomes active only for later samples.

Anchors are append-only capture records, so `end()` deliberately closes anchor admission as well as
sample admission. A very short or fully offline run that queues END before its first valid server
ACK or SNTP reading can therefore complete with monotonic timestamps only. Keep capture open through
the first acknowledged frame when UTC is required; END ACK and local `Complete` do not retroactively
anchor earlier samples.

## Journal, capabilities, and RAM

The UNO profile has six 768-byte frame slots. Each slot is 776 bytes including length/state/ordinal,
so `FixedJournal` is exactly 4,656 bytes. One slot remains reserved from sample traffic for control
or GAP reporting. The portable `Core` is 1,416 bytes on RA4M1, including its single 768-byte sample
builder, fixed truthful pending-GAP queue, and trusted slot metadata. The complete `AlloyUnoR4`
object is 7,016 bytes; a stack `Sample` is 304 bytes.

Final `arduino-cli` link results with core 1.6.0:

| Example | Flash | Global RAM | Reported headroom |
| --- | ---: | ---: | ---: |
| UnoR4Starter | 88,688 / 262,144 bytes (33%) | 14,704 / 32,768 bytes (44%) | 18,064 bytes |
| UnoR4Telemetry | 88,776 / 262,144 bytes (33%) | 14,704 / 32,768 bytes (44%) | 18,064 bytes |

Those linker totals are the trustworthy SRAM measurement. `mallinfo().fordblks` returned zero or
tiny values on this RA4M1 core and is deliberately neither exposed nor advertised. Runtime network
library allocations and stack use still come from the reported headroom.

Advertised capability bits are verified TLS, append-only UTC anchors, observable backpressure,
cached RSSI, explicit analog sampling, explicit digital sampling, and (when initialization succeeds)
the LED matrix. Persistent journal, free-memory approximation, and OTA remain clear. Registry:

| Board code | Adapter revision | Meaning |
| ---: | ---: | --- |
| 1 | 1 | Arduino UNO R4 WiFi, first Alloy cooperative adapter |

## LED and completion states

The matrix changes only outside capture:

| Pattern/state | Meaning |
| --- | --- |
| Connecting | association or DHCP is in progress |
| Online | network is ready and no upload call is active |
| Uploading | one TLS/HTTP frame attempt is active |
| Buffering | retained data is waiting through backoff |
| Complete | the exact RUN_END frame was ACKed |
| Error | authentication blocked, stale run, or terminal fault |

`State::Complete` and the Complete LED are not proof that asynchronous cloud MCAP assembly and mesh
upload have finished. They mean every device frame, including RUN_END, was acknowledged. Verify the
mission separately downstream when cloud-finalization completion matters.

## Reset and recovery

Tier 1 never writes telemetry to flash. Reset creates a new SCE-generated run ID; the server
inactivity-finalizes any previous unended run. Data still in the old RAM journal is unrecoverable and
loss must not be described as tier-2 recovery.

If a sketch prevents normal USB upload, double-tap the UNO R4 RESET button to enter its bootloader,
select the bootloader serial port if it re-enumerates, and upload a known-good sketch. This adapter
does not claim or enable OTA.
