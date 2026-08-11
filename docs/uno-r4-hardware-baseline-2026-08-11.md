# Uno R4 WiFi hardware baseline — 2026-08-11

## Outcome

The Arduino/toolchain/USB path and a complete routed Wi-Fi path are verified. On the `ALLOY`
network the Uno R4 WiFi associated, received an IPv4 lease, resolved DNS, completed a verified TLS
handshake, received an HTTP response, and printed `RESULT=PASS`. This clears the execution plan's
hardware gate; work on the portable protocol, core, Uno adapter, and parallel cloud route started
only after this result was observed.

The access point did not provide the ESP32-S3 coprocessor with an NTP result during the probe's
30-second bound. This is not treated as a network failure because verified HTTPS works. The adapter
uses an authenticated server-response timestamp as an explicitly approximate UTC anchor and can
append a higher-quality SNTP anchor later if one becomes available; prior samples are never rewritten.

The probe calls `WiFi.end()` after its result, so the board was not left associated to the network.

## Verified baseline

| Item | Observed value |
| --- | --- |
| Board | Arduino UNO R4 WiFi |
| USB port | `/dev/cu.usbmodemF0F5BD509C002` |
| FQBN | `arduino:renesas_uno:unor4wifi` |
| Arduino CLI | 1.5.0 |
| Renesas UNO core | 1.6.0 |
| WiFiS3 library | bundled `0.0.0` from core 1.6.0 |
| ESP32-S3 connectivity firmware | updated and verified at 0.6.0 |
| Probe compile | 66,800 bytes flash; 7,768 bytes global RAM |
| Upload | bossac completed and the board re-enumerated on the same USB port |
| Serial | 115200 baud markers and complete diagnostics captured |

Arduino's official firmware uploader 2.4.1 upgraded the ESP32-S3 from 0.5.2 to 0.6.0. The board
was physically power-cycled after the update before another sketch was uploaded.

## Routed network evidence

The credentials were supplied at runtime and held in host/board RAM only. They were not compiled
into a sketch or written to the repository.

1. The Mac and Uno independently joined `ALLOY` on `10.10.1.0/24`.
2. The hardened board probe observed:
   - association in 109 ms;
   - DHCP ready in 1,549 ms;
   - local address `10.10.1.26`;
   - gateway and DNS `10.10.1.1`;
   - RSSI `-73 dBm`;
   - successful DNS resolution for `alloylogger.com`;
   - verified TLS connection in 2,910 ms;
   - `HTTP/1.1 200 OK`, first byte in 441 ms; and
   - `RESULT=PASS`.
3. The Mac independently had a DHCP lease, working DNS, and an outbound HTTPS 200 response on the
   same network.
4. `WiFi.getTime()` remained zero for 30 seconds. This demonstrates why network-independent capture
   and append-only HTTPS-derived clock anchors are required for broad Wi-Fi compatibility.
5. The credentials were supplied over USB serial at runtime. They were not embedded in the sketch,
   written to a file, or printed to the serial log.

## TLS identity matrix

A second physical-board matrix tested the trust and identity behavior used by the final adapter:

| Case | Observed `connect()` result |
| --- | ---: |
| Public valid chain and matching hostname through WiFiS3's default bundle | accepted (`1`) |
| Locally rooted chain through the default bundle | rejected (`0`) |
| Public valid chain presented for a deliberately mismatched hostname | rejected (`0`) |
| Correct local chain through stock `setCACert()` with the matching host | rejected (`0`) |
| Correct local chain through the adapter workaround with the matching host | accepted (`1`) |
| Same local root through the adapter workaround with a mismatched hostname | rejected (`0`) |

The stock custom-root case exposed a connectivity-firmware 0.6.0 limitation rather than a
certificate error.
The [tagged bridge](https://github.com/arduino/uno-r4-wifi-usb-bridge/blob/0.6.0/UNOR4USBBridge/cmds_wifi_SSL.h)
receives exactly the PEM byte count into `clients_ca` and passes its data pointer without appending a
guaranteed NUL, while the [pinned ESP32 TLS implementation](https://github.com/arduino/arduino-esp32/blob/a2b82168bed7e43636271e757bde9d28e8014977/libraries/WiFiClientSecure/src/ssl_client.cpp)
measures that pointer with `strlen()`. OpenSSL independently accepted the same chain and hostname.
The adapter's bounded custom-root envelope path includes the existing C-string terminator in the AT
passthrough; the physical matching-host/mismatched-host results above verify that trust and hostname
checks remain active. Certificate syntax and base64 validity are still decided by the verified TLS
handshake. The null/default path is unchanged and continues to use WiFiS3's public root bundle.

## Hardware gate result

The required conditions are now proven on physical hardware:

- compile and upload with `arduino:renesas_uno:unor4wifi`;
- native USB serial exchange;
- 2.4 GHz association and IPv4 DHCP;
- DNS resolution;
- verified outbound TLS and HTTP; and
- bounded failure reporting when optional NTP is unavailable.

The temporary reproducible probe remains in `.uno-probe/UnoProbe` with its credential-free host
runner in `.uno-probe/run_probe.py`.

## Physical binary-ingest matrix

The final adapter was flashed and exercised through the local `/v2/frame` Worker against the real
Alloy data API. No Worker was deployed. A LAN-local TLS proxy accepted only the Uno's observed
address and a fixed non-secret test token; it replaced that token with the real bearer credential
only on the loopback hop to the Worker. The real key was therefore never sent to, stored on, or
logged by the board. Raw frame captures contained bodies only.

| Scenario | Run ID | Verified result |
| --- | --- | --- |
| Normal | `7565af1a33f06959046b627a889821b3` | 100 samples, 1 anchor, no loss, explicit END; 29,519-byte MCAP |
| Wi-Fi reconnect | `e133f6ba52d3d37b62fe3af8ae67854d` | forced link loss, second DHCP-ready event, 2 Wi-Fi attempts, 100 samples, 2 anchors, no loss; 29,757-byte MCAP |
| Dropped response/retry | `9248826a8e700761c09474c836fdba3c` | frame 2 sent twice with byte-identical bodies; one stored frame, retry metadata present, 100 samples; 29,519-byte MCAP |
| Fixed-RAM overflow | `52fbf680be4fe06106176ea15ea886ef` | 300 attempted, 96 retained, 204 explicitly dropped; GAP and END totals agree exactly; 28,200-byte MCAP |
| Reset, pre-reset run | `f967edc086020ee5730641ce84e441a3` | 38 samples and 1 anchor, no END, inactivity-finalized with `complete=false`; 13,933-byte MCAP |
| Reset, new run | `1e04b38dbf77566084c265275fce3c9d` | new random run ID, 100 samples, no loss, explicit END; 29,518-byte MCAP |

The capture verifier checked frame CRCs, exact duplicate bytes, declarations, counters, sequence
holes versus GAP ranges, and the reset pair's one-END/one-no-END split. Each MCAP was then listed
and downloaded again from `uploads/sdk-uploads/arduino/uno-r4-e2e/<run-id>/`. An independent indexed
reader verified typed JSON Schemas, monotonic message times, anchored sample suffixes, mission
metadata, sample counts, loss totals, and completion state. `mcap info` on the normal mission showed
100 `/board_io` messages plus one clock anchor.

Four earlier reset-harness calibration runs also reached the same temporary mission prefix:
`8d0b9c790f03a0f3a5aa31a34a5a1f3a`, `9c3ba8fec4fefbe746dffe22eb74fe13`,
`c0494d4690276c6da5f5ee1d3955ba8f`, and `78388c07fdd976e21bff1d343ba276a7`.
They are not gate evidence; the final six runs above supersede them.

Alloy Mesh object listing, download, and local replay verification passed. Hosted SQL did not yet
return the oldest run from `alloy.mesh.file_meta` after a bounded 180-second poll. Alloy documents
SQL as available only after the uploaded file advances from Queued/Processing to Ready, while
Replay and Inspect work as soon as the object lands. The signed-in status page was not available in
the unattended browser session, so the remaining downstream signal is accurately recorded as
external processing/catalogue lag rather than silently claimed as Ready.

After the matrix, the local Worker and proxy were stopped, the exact temporary Worker state and
throwaway TLS private key were removed, and a credential-free sketch reset the board, called
`WiFi.end()`, and printed `ALLOY_UNO_WIFI_DISCONNECTED` over USB.

## Repository safety

Before this run, five unrelated mission-label edits were already present in:

- `src/AlloyLogger.h`
- `src/AlloyLogger.cpp`
- `cloud/src/types.ts`
- `cloud/src/mcap.ts`
- `cloud/test/mcap.test.ts`

Their combined pre-run patch is saved at `/private/tmp/alloy-logger-arduino-pre-uno.patch` with
SHA-256 `c1bf232f1361f68daabf97a6fe6de54d2c5f606ffa7f3c7a0d81019190988c0a`.
Those edits were not modified. No deployment, commit, push, or credential rotation occurred.
