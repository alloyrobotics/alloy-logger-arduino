# Alloy Device Wire v1

Status: implementation contract for the Uno R4 path. The legacy `/v1/*` CSV protocol is unchanged.

## Scope and honesty

The portable core knows only frames, a fixed-capacity journal, monotonic time, clock anchors, and
acknowledgements. Arduino, WiFiS3, TLS, HTTP, Cloudflare, and storage are adapter concerns.

The bearer key currently proves access to an Alloy organization/path. `device_id` is self-asserted
metadata, not an enrolled hardware identity. CRC32C detects accidental corruption; it is not a MAC
or authentication mechanism.

All integers are little-endian. Reserved fields and unknown v1 flags must be zero. The protocol
maximum is 1,024 bytes per complete frame. The Uno R4 profile advertises and uses 768 bytes.

## Frame envelope

Every request body is one complete frame. Total bytes are `64 + payload_bytes`.

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `ALY1` |
| 4 | 1 | wire version, exactly `1` |
| 5 | 1 | frame type |
| 6 | 2 | flags, zero in v1 |
| 8 | 2 | header bytes, exactly `64` |
| 10 | 2 | payload bytes |
| 12 | 4 | global `frame_seq`; begins at zero, maximum `0xfffffffe`, and must not wrap |
| 16 | 16 | cryptographically random `run_id` |
| 32 | 2 | journal slots used when the transmitted frame bytes were sealed |
| 34 | 2 | journal slot capacity |
| 36 | 4 | cumulative dropped samples, saturating |
| 40 | 4 | cumulative dropped frames, saturating |
| 44 | 4 | cumulative corrupt journal frames, saturating |
| 48 | 4 | cumulative backpressure events, saturating |
| 52 | 4 | cumulative retry attempts, saturating |
| 56 | 4 | reserved zero |
| 60 | 4 | CRC32C |
| 64 | N | type-specific payload |

Frame types are `1 RUN_BEGIN`, `2 CAPABILITIES`, `3 SCHEMA`, `4 UTC_ANCHOR`, `5 SAMPLES`,
`6 GAP`, and `7 RUN_END`.

CRC is reflected CRC32C/Castagnoli: polynomial `0x82f63b78`, initial value `0xffffffff`, final XOR
`0xffffffff`. Calculate it over the whole header and payload with bytes 60 through 63 treated as
zero. The check vector `123456789` is `0xe3069283`.

A retry is byte-identical, including counters and CRC.

`0xffffffff` is reserved as the unknown/exhausted sequence sentinel used by GAP and ACK fields. It
is never a frame or sample sequence. A device faults with sequence exhaustion before allocating it;
this also lets the 32-bit ACK `lowest_missing_seq` represent completion of every usable sequence.

## Enumerations

Reliability tiers are `1 volatile best effort`, `2 recoverable`, and `3 loss-intolerant`.

Schema field types and widths:

| Code | Type | Bytes |
| ---: | --- | ---: |
| 1 | bool, wire value exactly 0 or 1 | 1 |
| 2 | signed 8-bit | 1 |
| 3 | unsigned 8-bit | 1 |
| 4 | signed 16-bit | 2 |
| 5 | unsigned 16-bit | 2 |
| 6 | signed 32-bit | 4 |
| 7 | unsigned 32-bit | 4 |
| 8 | IEEE-754 binary32 | 4 |
| 9 | IEEE-754 binary64 | 8 |

User i64/u64 fields are excluded because the JSON-encoded MCAP path cannot preserve their full
range losslessly. Present floating-point values must be finite. NaN and infinity are encoded absent.

UTC anchor sources are `1 SNTP`, `2 RTC`, `3 authenticated host`, and `4 GNSS`. Qualities are
`1 approximate` and `2 synchronized`.

Capability bits are: bit 0 verified TLS, 1 UTC anchors, 2 persistent journal, 3 backpressure,
4 cached RSSI, 5 analog sampling, 6 digital sampling, 7 LED matrix, 8 free-memory approximation,
and 9 OTA. A bit remains clear until that capability is actually verified.

## RUN_BEGIN

The first 16 bytes are followed immediately by strings:

| Offset | Field |
| ---: | --- |
| 0 | device length `u8`, 1 through 32 |
| 1 | firmware length `u8`, 0 through 32 |
| 2 | mission length `u8`, 0 through 64 |
| 3 | reliability tier `u8` |
| 4 | boot reason `u8` |
| 5 | three reserved zero bytes |
| 8 | `mono_start_us u64` |
| 16 | device, firmware, and mission bytes |

Device IDs match `[A-Za-z0-9_-]{1,32}`. Firmware and mission strings are valid UTF-8 without NUL
or control characters. Maximum payload is 144 bytes.

The Uno adapter obtains the 128-bit run ID from the RA4M1 SCE TRNG. Entropy failure or an all-zero
result fails `begin()`; there is no time-, ADC-, or PRNG-based fallback.

## CAPABILITIES

A 32-byte fixed prefix is followed by board/core/radio strings:

| Offset | Field |
| ---: | --- |
| 0 | board code `u16` |
| 2 | adapter revision `u16` |
| 4 | capability bits `u64` |
| 12 | maximum frame bytes `u16` |
| 14 | journal slots `u16` |
| 16 | journal slot bytes `u16` |
| 18 | maximum schemas `u8` |
| 19 | maximum fields per schema `u8` |
| 20 | journal kind `u8`: 0 RAM, 1 internal flash, 2 external flash, 3 SD |
| 21 | active reliability tier `u8` |
| 22 | monotonic resolution microseconds `u16` |
| 24 | scheduler kind `u8`: 1 cooperative, 2 threaded |
| 25 | board string length `u8` |
| 26 | core string length `u8` |
| 27 | radio string length `u8` |
| 28 | reserved `u32` |
| 32 | board, core, and radio strings |

The string bounds are 32, 24, and 24 bytes. Uno R4 initially advertises tier 1 and RAM journal only.

## SCHEMA

The prefix is `schema_id u16`, `revision u16`, `channel_len u8`, `field_count u8`, and zero
`flags u16`, followed by the channel and field descriptors.

Channels are 1 through 24 bytes and match `[A-Za-z0-9_-]+`. There are at most 16 fields. Each
descriptor is:

```text
field_id:u8 | type:u8 | flags:u8 | name_len:u8 | unit_len:u8 | reserved:u8 |
name[name_len] | unit[unit_len]
```

Field IDs are exactly 0 through `field_count - 1`. Names are 1 through 24 bytes, cannot begin
`_alloy_`, and use the same safe identifier alphabet as channels. Units are 0 through 12 printable
ASCII bytes. Maximum payload is 704 bytes. `(schema_id, revision)` is immutable; any change uses a
new revision.

## UTC_ANCHOR

Payload is exactly 32 bytes:

```text
anchor_id:u16 | source:u8 | quality:u8 | uncertainty_us:u32 |
mono_us:u64 | utc_ns:u64 | frequency_error_ppb:i32 | reserved:u32
```

`INT32_MIN` means unknown frequency error. Anchors are append-only and immutable. Data captured
before synchronization uses anchor ID zero. `utc_ns` must be nonzero. After an anchor is declared,
samples use that most recently declared anchor ID until a newer anchor is declared; future, skipped,
or otherwise unknown anchor IDs are invalid. No historical journal bytes are rewritten.

If UDP NTP is unavailable, a TLS-authenticated ACK supplies `X-Alloy-Server-UTC-Ns`. The adapter
may append an authenticated-host, approximate anchor with uncertainty of at least the measured
round-trip time plus the server clock's 1 ms resolution. A later SNTP result appends a synchronized
anchor; it does not change prior frames.

## SAMPLES

The 16-byte prefix is:

```text
record_count:u16 | reserved:u16 | base_mono_us:u64 |
record_header_bytes:u16 (=20) | reserved:u16
```

There are 1 through 64 records. Each record is:

```text
record_bytes:u16 | schema_id:u16 | revision:u16 | anchor_id:u16 |
sample_seq:u32 | mono_delta_us:u32 | present_mask:u16 | reserved:u16 |
fixed-width field values in schema order
```

`record_bytes` is `20 + sum(all schema field widths)`. Bytes for absent values remain zero so record
width is deterministic. The first delta is zero; later deltas are nondecreasing. Seal before a delta
would exceed `UINT32_MAX`. Absolute sample time is `base_mono_us + mono_delta_us`. Sample sequences
begin at zero, may reach `0xfffffffe`, and exhaust before the reserved `0xffffffff` value. A sample
may reference only a schema declared by a lower frame sequence. Its anchor is zero before the first
prior anchor declaration, otherwise exactly the latest anchor declared by a lower frame sequence.

## GAP

Payload is exactly 40 bytes:

```text
reason:u8 | action:u8 | reserved:u16 |
first_lost_sample_seq:u32 | lost_sample_count:u32 |
first_lost_frame_seq:u32 | lost_frame_count:u32 |
mono_start_us:u64 | mono_end_us:u64 | detail:u32
```

Reasons are `1 journal full`, `2 encoder rejection`, `3 clock regression`, `4 journal CRC failure`,
`5 reset recovery`, and `6 end-drain timeout`. Actions are `1 drop newest`, `2 would block`, and
`3 faulted`. Unknown ranges use `UINT32_MAX`. A fixed pending-gap structure exists outside the data
slots so loss reporting cannot be displaced by the loss condition itself.

## RUN_END

Payload is exactly 40 bytes:

```text
reason:u8 | reserved:u8 | flags:u16 | mono_end_us:u64 |
attempted_samples:u32 | encoded_samples:u32 | dropped_samples:u32 |
dropped_frames:u32 | corrupt_frames:u32 | backpressure_events:u32 | retries:u32
```

Capture closes before this final frame is queued. Explicit mission finalization begins only after it
and every preceding frame is acknowledged. Power loss has no end frame; server inactivity finalizes
the old run with `end_observed=false`. The END time/reason are latched when capture closes. The frame
may be queued behind retained predecessors, but its cumulative counters and CRC are sealed only when
it reaches the front immediately before first transmission, so retries needed to drain earlier
frames are included. Retries of END itself cannot alter its already sealed bytes.

## Binary acknowledgement

Every successfully parsed server response is a 48-byte body:

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `ALYA` |
| 4 | 1 | version 1 |
| 5 | 1 | status |
| 6 | 2 | flags |
| 8 | 2 | ACK bytes, exactly 48 |
| 10 | 2 | detail |
| 12 | 4 | acknowledged frame sequence |
| 16 | 4 | lowest sequence neither received nor explicitly lost |
| 20 | 4 | retry-after milliseconds |
| 24 | 16 | run ID |
| 40 | 4 | ACK CRC32C |
| 44 | 4 | request-frame CRC echo |

ACK CRC uses the frame CRC algorithm with bytes 40 through 43 zero. Flags are `0x0001 accepted`,
`0x0002 duplicate`, `0x0004 retryable`, and `0x0008 run terminal`.

Statuses are: `0 accepted`, `1 duplicate`, `2 bad magic`, `3 bad version`, `4 bad length`,
`5 bad CRC`, `6 run not started`, `7 run finalized`, `8 sequence conflict`, `9 unknown schema`,
`10 schema conflict`, `11 invalid sample`, `12 authentication failure`, `13 rate limited`, `14 busy`,
`15 internal error`, `16 identity conflict`, and `17 protocol-format conflict`.

The device frees a slot only after validating ACK magic, version, length, CRC, exact run ID, exact
frame sequence, and echoed request CRC. A bare HTTP 2xx is insufficient.

- Timeout, malformed ACK, 429, retryable/busy, and 5xx retain the byte-identical frame and retry
  exponentially, capped at 30 seconds.
- Exact duplicate reclaims the slot once.
- Sequence conflict or invalid locally-generated data faults the run without silently discarding it.
- 401/403 enters `AUTH_BLOCKED`; this is an organization/path credential failure, not enrollment.
- A finalized run closes stale and never silently begins a replacement run.

## HTTP binding

POST one frame to `/v2/frame` with content type `application/vnd.alloy.frame;version=1` and headers
`Authorization: Bearer`, `X-Alloy-Device`, `X-Alloy-Run` (32 lowercase run-ID hex), and
`X-Alloy-Mesh-Path`. `X-Alloy-Finalize-Ms` remains optional. A valid ACK uses content type
`application/vnd.alloy.ack;version=1` and includes decimal `X-Alloy-Server-UTC-Ns`.

The Worker reads actual stream bytes to 1,024 and cancels/rejects at byte 1,025 regardless of
`Content-Length`.

## Journal invariants

The Uno profile has six 768-byte slots. Each RAM slot is 776 bytes:

```text
len:u16 | state:u8 | reserved:u8 | ordinal:u32 | bytes[768]
```

Total journal storage is 4,656 bytes. One slot remains reservable for control/GAP traffic. The core
has one builder and one network frame in flight. Capture performs bounds checks, monotonic clock
reads, integer writes/memcpy, and CRC on seal; it performs no allocation, formatting, network,
filesystem work, or blocking lock.

Tier 1 drops newest when full and records a pending GAP. Reset creates a new run; the server
inactivity-finalizes the old one. Tier 2 restores an adapter-provided atomic persistent journal and
the same run ID. Tier 3 returns `WOULD_BLOCK` without allocating a sample sequence. Uno R4 initially
claims tier 1 only. Tier 3 protects an active run with backpressure; it does not by itself claim
power-loss recovery. That separate claim requires a persistent journal and verified restore path.

The 32-bit `micros()` source is extended using unsigned deltas. To distinguish a wrap from a backward
regression using the raw counter alone, `poll()` must run at least once per `2^31` microseconds
(about 35.8 minutes). A detected regression rejects the sample and emits a GAP rather than clamping
time.

## Cloud and MCAP projection

The Worker routes by key hash and run ID, then pins the self-asserted device and mesh path from
RUN_BEGIN. It stages and deduplicates on `(frame_seq, SHA-256 of exact bytes)`, not CRC alone.
Identical retries receive duplicate ACKs; same sequence with different bytes returns 409 and never
overwrites the original.

At finalization, the earliest synchronized anchor, otherwise the earliest approximate anchor, fixes:

```text
offset_ns = utc_ns - mono_us * 1000
logTime   = offset_ns + sample_mono_us * 1000
```

Later anchors are retained on `/alloy/clock_anchor` with their residual and never alter sample order.
Without an anchor, log time is monotonic nanoseconds and metadata says `utc_anchored=false`; server
arrival time is never invented as capture time. Samples order by `(mono_us, sample_seq)`. Schema
revisions are separate typed MCAP channel generations. Each payload preserves `_alloy_mono_us`,
`_alloy_anchor_id`, and `_alloy_sample_seq`; GAPs are messages on `/alloy/gap`.

Mission metadata includes run ID, asserted device, reliability tier, capabilities, backlog/loss/
corruption totals, and completeness. Output is `<mesh>/<run-id>/<device>_<run-id>.mcap`.

Ingress and per-frame decoding are bounded. The existing MCAP writer and mesh PUT still hold the
whole completed mission in memory; this implementation does not claim a bounded whole-session
finalizer until that separate output seam is changed.

## Golden vectors

Canonical RUN_BEGIN (`run_id = 000102...0f`, device `uno-r4-01`, firmware `fw1`, mono 1000,
sequence 0, journal 1/6):

```text
414c59310101000040001c0000000000000102030405060708090a0b0c0d0e0f01000600000000000000000000000000000000000000000000000000747ccf680903000101000000e803000000000000756e6f2d72342d3031667731
```

Its accepted ACK:

```text
414c59410100010030000000000000000100000000000000000102030405060708090a0b0c0d0e0f21eb0099747ccf68
```

Every C++ and TypeScript implementation must reproduce and decode these vectors, plus cover truncation,
max+1, nonzero reserved bytes, bad CRC, byte-identical duplicates, sequence conflicts, schema conflicts,
unknown schema, record/mask/type errors, pre-anchor and no-anchor data, lost ACK retry, journal overflow,
explicit end, inactivity end, and unchanged legacy `/v1/*` behavior.
