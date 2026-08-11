#ifndef ALLOY_DEVICE_PROTOCOL_H_
#define ALLOY_DEVICE_PROTOCOL_H_

#include <stddef.h>
#include <stdint.h>

namespace alloy {
namespace device {
namespace v1 {

static const uint8_t kWireVersion = 1;
static const uint16_t kFrameHeaderBytes = 64;
static const uint16_t kAckBytes = 48;
static const size_t kProtocolMaxFrameBytes = 1024;
static const size_t kUnoFrameBytes = 768;
static const uint8_t kMaxFieldsPerSchema = 16;
static const uint8_t kMaxSampleRecords = 64;

enum FrameType {
  RUN_BEGIN = 1,
  CAPABILITIES = 2,
  SCHEMA = 3,
  UTC_ANCHOR = 4,
  SAMPLES = 5,
  GAP = 6,
  RUN_END = 7
};

enum ReliabilityTier {
  VOLATILE_BEST_EFFORT = 1,
  RECOVERABLE = 2,
  LOSS_INTOLERANT = 3
};

enum FieldType {
  FIELD_BOOL = 1,
  FIELD_I8 = 2,
  FIELD_U8 = 3,
  FIELD_I16 = 4,
  FIELD_U16 = 5,
  FIELD_I32 = 6,
  FIELD_U32 = 7,
  FIELD_F32 = 8,
  FIELD_F64 = 9
};

enum AnchorSource {
  ANCHOR_SNTP = 1,
  ANCHOR_RTC = 2,
  ANCHOR_AUTHENTICATED_HOST = 3,
  ANCHOR_GNSS = 4
};

enum AnchorQuality {
  ANCHOR_APPROXIMATE = 1,
  ANCHOR_SYNCHRONIZED = 2
};

enum CapabilityBits {
  CAPABILITY_VERIFIED_TLS = 1ull << 0,
  CAPABILITY_UTC_ANCHORS = 1ull << 1,
  CAPABILITY_PERSISTENT_JOURNAL = 1ull << 2,
  CAPABILITY_BACKPRESSURE = 1ull << 3,
  CAPABILITY_CACHED_RSSI = 1ull << 4,
  CAPABILITY_ANALOG_SAMPLING = 1ull << 5,
  CAPABILITY_DIGITAL_SAMPLING = 1ull << 6,
  CAPABILITY_LED_MATRIX = 1ull << 7,
  CAPABILITY_FREE_MEMORY_APPROXIMATION = 1ull << 8,
  CAPABILITY_OTA = 1ull << 9
};

enum JournalKind {
  JOURNAL_RAM = 0,
  JOURNAL_INTERNAL_FLASH = 1,
  JOURNAL_EXTERNAL_FLASH = 2,
  JOURNAL_SD = 3
};

enum SchedulerKind {
  SCHEDULER_COOPERATIVE = 1,
  SCHEDULER_THREADED = 2
};

enum RunEndReason {
  RUN_END_EXPLICIT = 1
};

enum GapReason {
  GAP_JOURNAL_FULL = 1,
  GAP_ENCODER_REJECTION = 2,
  GAP_CLOCK_REGRESSION = 3,
  GAP_JOURNAL_CRC_FAILURE = 4,
  GAP_RESET_RECOVERY = 5,
  GAP_END_DRAIN_TIMEOUT = 6
};

enum GapAction {
  GAP_DROP_NEWEST = 1,
  GAP_WOULD_BLOCK = 2,
  GAP_FAULTED = 3
};

enum AckStatus {
  ACK_ACCEPTED = 0,
  ACK_DUPLICATE = 1,
  ACK_BAD_MAGIC = 2,
  ACK_BAD_VERSION = 3,
  ACK_BAD_LENGTH = 4,
  ACK_BAD_CRC = 5,
  ACK_RUN_NOT_STARTED = 6,
  ACK_RUN_FINALIZED = 7,
  ACK_SEQUENCE_CONFLICT = 8,
  ACK_UNKNOWN_SCHEMA = 9,
  ACK_SCHEMA_CONFLICT = 10,
  ACK_INVALID_SAMPLE = 11,
  ACK_AUTHENTICATION_FAILURE = 12,
  ACK_RATE_LIMITED = 13,
  ACK_BUSY = 14,
  ACK_INTERNAL_ERROR = 15,
  ACK_IDENTITY_CONFLICT = 16,
  ACK_PROTOCOL_FORMAT_CONFLICT = 17
};

enum AckFlags {
  ACK_FLAG_ACCEPTED = 0x0001,
  ACK_FLAG_DUPLICATE = 0x0002,
  ACK_FLAG_RETRYABLE = 0x0004,
  ACK_FLAG_RUN_TERMINAL = 0x0008
};

struct RunId {
  uint8_t bytes[16];
};

struct TextView {
  const char* data;
  uint8_t size;
};

struct FrameCounters {
  uint32_t dropped_samples;
  uint32_t dropped_frames;
  uint32_t corrupt_frames;
  uint32_t backpressure_events;
  uint32_t retries;
};

struct FrameContext {
  uint32_t frame_seq;
  RunId run_id;
  uint16_t journal_slots_used;
  uint16_t journal_slot_capacity;
  FrameCounters counters;
};

struct RunBeginPayload {
  TextView device;
  TextView firmware;
  TextView mission;
  ReliabilityTier reliability;
  uint8_t boot_reason;
  uint64_t mono_start_us;
};

struct CapabilitiesPayload {
  uint16_t board_code;
  uint16_t adapter_revision;
  uint64_t capability_bits;
  uint16_t maximum_frame_bytes;
  uint16_t journal_slots;
  uint16_t journal_slot_bytes;
  uint8_t maximum_schemas;
  uint8_t maximum_fields_per_schema;
  uint8_t journal_kind;
  ReliabilityTier active_reliability;
  uint16_t monotonic_resolution_us;
  uint8_t scheduler_kind;
  TextView board;
  TextView core;
  TextView radio;
};

struct FieldDescriptor {
  uint8_t field_id;
  FieldType type;
  uint8_t flags;
  TextView name;
  TextView unit;
};

struct SchemaPayload {
  uint16_t schema_id;
  uint16_t revision;
  TextView channel;
  uint8_t field_count;
  const FieldDescriptor* fields;
};

struct UtcAnchorPayload {
  uint16_t anchor_id;
  AnchorSource source;
  AnchorQuality quality;
  uint32_t uncertainty_us;
  uint64_t mono_us;
  uint64_t utc_ns;
  int32_t frequency_error_ppb;
};

union SampleValue {
  uint8_t boolean_value;
  int8_t i8_value;
  uint8_t u8_value;
  int16_t i16_value;
  uint16_t u16_value;
  int32_t i32_value;
  uint32_t u32_value;
  float f32_value;
  double f64_value;
};

struct SampleFieldValue {
  uint8_t present;
  SampleValue value;
};

struct SampleRecordPayload {
  uint16_t schema_id;
  uint16_t revision;
  uint16_t anchor_id;
  uint32_t sample_seq;
  uint64_t mono_us;
  uint8_t field_count;
  const FieldType* field_types;
  const SampleFieldValue* fields;
};

struct SamplesPayload {
  uint64_t base_mono_us;
  uint16_t record_count;
  const SampleRecordPayload* records;
};

struct GapPayload {
  GapReason reason;
  GapAction action;
  uint32_t first_lost_sample_seq;
  uint32_t lost_sample_count;
  uint32_t first_lost_frame_seq;
  uint32_t lost_frame_count;
  uint64_t mono_start_us;
  uint64_t mono_end_us;
  uint32_t detail;
};

struct RunEndPayload {
  uint8_t reason;
  uint16_t flags;
  uint64_t mono_end_us;
  uint32_t attempted_samples;
  uint32_t encoded_samples;
  uint32_t dropped_samples;
  uint32_t dropped_frames;
  uint32_t corrupt_frames;
  uint32_t backpressure_events;
  uint32_t retries;
};

enum EncodeStatus {
  ENCODE_OK = 0,
  ENCODE_INVALID_ARGUMENT,
  ENCODE_INVALID_TEXT,
  ENCODE_INVALID_ENUM,
  ENCODE_INVALID_FIELD,
  ENCODE_NONFINITE_FLOAT,
  ENCODE_BUFFER_TOO_SMALL,
  ENCODE_FRAME_TOO_LARGE
};

struct FrameInfo {
  FrameType type;
  uint16_t payload_bytes;
  uint32_t frame_seq;
  RunId run_id;
  uint16_t journal_slots_used;
  uint16_t journal_slot_capacity;
  FrameCounters counters;
  uint32_t crc32c;
};

struct Ack {
  AckStatus status;
  uint16_t flags;
  uint16_t detail;
  uint32_t frame_seq;
  uint32_t lowest_unresolved_seq;
  uint32_t retry_after_ms;
  RunId run_id;
  uint32_t crc32c;
  uint32_t request_frame_crc;
};

enum AckValidation {
  ACK_VALID = 0,
  ACK_INVALID_ARGUMENT,
  ACK_INVALID_SIZE,
  ACK_INVALID_MAGIC,
  ACK_INVALID_VERSION,
  ACK_INVALID_FLAGS,
  ACK_INVALID_CRC,
  ACK_WRONG_RUN,
  ACK_WRONG_SEQUENCE,
  ACK_WRONG_REQUEST_CRC
};

uint32_t crc32c(const uint8_t* bytes, size_t size);
uint8_t fieldWidth(FieldType type);

EncodeStatus encodeRunBeginPayload(uint8_t* output, size_t capacity,
                                   const RunBeginPayload& payload,
                                   size_t* encoded_bytes);
EncodeStatus encodeCapabilitiesPayload(uint8_t* output, size_t capacity,
                                      const CapabilitiesPayload& payload,
                                      size_t* encoded_bytes);
EncodeStatus encodeSchemaPayload(uint8_t* output, size_t capacity,
                                 const SchemaPayload& payload,
                                 size_t* encoded_bytes);
EncodeStatus encodeUtcAnchorPayload(uint8_t* output, size_t capacity,
                                    const UtcAnchorPayload& payload,
                                    size_t* encoded_bytes);
EncodeStatus encodeSamplesPayload(uint8_t* output, size_t capacity,
                                  const SamplesPayload& payload,
                                  size_t* encoded_bytes);
EncodeStatus encodeGapPayload(uint8_t* output, size_t capacity,
                              const GapPayload& payload,
                              size_t* encoded_bytes);
EncodeStatus encodeRunEndPayload(uint8_t* output, size_t capacity,
                                 const RunEndPayload& payload,
                                 size_t* encoded_bytes);

EncodeStatus encodeFrame(uint8_t* output, size_t capacity, FrameType type,
                         const FrameContext& context, const uint8_t* payload,
                         size_t payload_bytes, size_t* encoded_bytes);
EncodeStatus encodeRunBeginFrame(uint8_t* output, size_t capacity,
                                 const FrameContext& context,
                                 const RunBeginPayload& payload,
                                 size_t* encoded_bytes);
EncodeStatus encodeCapabilitiesFrame(uint8_t* output, size_t capacity,
                                     const FrameContext& context,
                                     const CapabilitiesPayload& payload,
                                     size_t* encoded_bytes);
EncodeStatus encodeSchemaFrame(uint8_t* output, size_t capacity,
                               const FrameContext& context,
                               const SchemaPayload& payload,
                               size_t* encoded_bytes);
EncodeStatus encodeUtcAnchorFrame(uint8_t* output, size_t capacity,
                                  const FrameContext& context,
                                  const UtcAnchorPayload& payload,
                                  size_t* encoded_bytes);
EncodeStatus encodeSamplesFrame(uint8_t* output, size_t capacity,
                                const FrameContext& context,
                                const SamplesPayload& payload,
                                size_t* encoded_bytes);
EncodeStatus encodeGapFrame(uint8_t* output, size_t capacity,
                            const FrameContext& context,
                            const GapPayload& payload,
                            size_t* encoded_bytes);
EncodeStatus encodeRunEndFrame(uint8_t* output, size_t capacity,
                               const FrameContext& context,
                               const RunEndPayload& payload,
                               size_t* encoded_bytes);

EncodeStatus inspectFrame(const uint8_t* frame, size_t size, FrameInfo* info);
AckValidation decodeAndValidateAck(const uint8_t* bytes, size_t size,
                                   const RunId& expected_run_id,
                                   uint32_t expected_frame_seq,
                                   uint32_t expected_request_crc, Ack* ack);

}  // namespace v1
}  // namespace device
}  // namespace alloy

#endif  // ALLOY_DEVICE_PROTOCOL_H_
