#include <alloy/device/core.h>
#include <alloy/device/protocol.h>

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <limits>
#include <vector>

using namespace alloy::device::v1;

namespace alloy {
namespace device {
namespace v1 {

struct CoreTestAccess {
  static void setNextFrameSequence(Core& core, uint32_t value) {
    core.next_frame_seq_ = value;
  }

  static void setNextSampleSequence(Core& core, uint32_t value) {
    core.next_sample_seq_ = value;
  }

  static void setStats(Core& core, const CoreStats& stats) {
    core.stats_ = stats;
  }

  static size_t findSlot(const Core& core, FrameType type,
                         size_t occurrence = 0) {
    for (size_t i = 0; i < kJournalSlotCount; ++i) {
      if (core.slot_metadata_valid_[i] &&
          core.slot_frame_types_[i] == static_cast<uint8_t>(type)) {
        if (occurrence == 0) {
          return i;
        }
        --occurrence;
      }
    }
    return kJournalSlotCount;
  }

  static JournalSlot& slot(Core& core, size_t index) {
    return core.journal_.slots_[index];
  }

  static const PendingGap& pendingGap(const Core& core, size_t index) {
    return core.pending_gaps_[index];
  }

  static bool enqueueGap(Core& core, const GapPayload& gap) {
    return core.enqueueGap(gap);
  }

  static bool endQueued(const Core& core) { return core.end_frame_queued_; }
  static uint32_t endSequence(const Core& core) { return core.end_frame_seq_; }
};

}  // namespace v1
}  // namespace device
}  // namespace alloy

namespace {

#define CHECK(expression)                                                     \
  do {                                                                        \
    if (!(expression)) {                                                      \
      fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__,       \
              #expression);                                                   \
      return false;                                                           \
    }                                                                         \
  } while (0)

static void putU16(uint8_t* output, uint16_t value) {
  output[0] = static_cast<uint8_t>(value);
  output[1] = static_cast<uint8_t>(value >> 8);
}

static void putU32(uint8_t* output, uint32_t value) {
  output[0] = static_cast<uint8_t>(value);
  output[1] = static_cast<uint8_t>(value >> 8);
  output[2] = static_cast<uint8_t>(value >> 16);
  output[3] = static_cast<uint8_t>(value >> 24);
}

static uint16_t getU16(const uint8_t* input) {
  return static_cast<uint16_t>(input[0]) |
         static_cast<uint16_t>(static_cast<uint16_t>(input[1]) << 8);
}

static uint32_t getU32(const uint8_t* input) {
  return static_cast<uint32_t>(input[0]) |
         (static_cast<uint32_t>(input[1]) << 8) |
         (static_cast<uint32_t>(input[2]) << 16) |
         (static_cast<uint32_t>(input[3]) << 24);
}

static uint64_t getU64(const uint8_t* input) {
  return static_cast<uint64_t>(getU32(input)) |
         (static_cast<uint64_t>(getU32(input + 4)) << 32);
}

static std::vector<uint8_t> fromHex(const char* hex) {
  std::vector<uint8_t> bytes;
  const size_t size = strlen(hex);
  bytes.reserve(size / 2);
  for (size_t i = 0; i < size; i += 2) {
    unsigned int value = 0;
    sscanf(hex + i, "%2x", &value);
    bytes.push_back(static_cast<uint8_t>(value));
  }
  return bytes;
}

static TextView text(const char* value) {
  TextView view;
  view.data = value;
  view.size = static_cast<uint8_t>(strlen(value));
  return view;
}

static RunId runId(uint8_t first = 0) {
  RunId id;
  for (size_t i = 0; i < sizeof(id.bytes); ++i) {
    id.bytes[i] = static_cast<uint8_t>(first + i);
  }
  return id;
}

static RunBeginPayload runBegin(ReliabilityTier tier = VOLATILE_BEST_EFFORT,
                                uint64_t mono = 1000) {
  RunBeginPayload payload;
  payload.device = text("uno-r4-01");
  payload.firmware = text("fw1");
  payload.mission = text("");
  payload.reliability = tier;
  payload.boot_reason = 1;
  payload.mono_start_us = mono;
  return payload;
}

static FrameContext frameContext() {
  FrameContext context;
  memset(&context, 0, sizeof(context));
  context.run_id = runId();
  context.journal_slots_used = 1;
  context.journal_slot_capacity = 6;
  return context;
}

static CapabilitiesPayload capabilities(ReliabilityTier tier =
                                            VOLATILE_BEST_EFFORT) {
  CapabilitiesPayload payload;
  memset(&payload, 0, sizeof(payload));
  payload.board_code = 1;
  payload.adapter_revision = 1;
  payload.capability_bits = CAPABILITY_VERIFIED_TLS | CAPABILITY_UTC_ANCHORS |
                            CAPABILITY_BACKPRESSURE;
  payload.maximum_frame_bytes = 768;
  payload.journal_slots = 6;
  payload.journal_slot_bytes = 768;
  payload.maximum_schemas = kCoreMaxSchemas;
  payload.maximum_fields_per_schema = kMaxFieldsPerSchema;
  payload.journal_kind = JOURNAL_RAM;
  payload.active_reliability = tier;
  payload.monotonic_resolution_us = 1;
  payload.scheduler_kind = SCHEDULER_COOPERATIVE;
  payload.board = text("uno-r4-wifi");
  payload.core = text("arduino");
  payload.radio = text("wifi-s3");
  return payload;
}

static SchemaPayload oneFieldSchema(FieldType type = FIELD_F32) {
  static FieldDescriptor descriptor;
  descriptor.field_id = 0;
  descriptor.type = type;
  descriptor.flags = 0;
  descriptor.name = text("temperature");
  descriptor.unit = text("C");
  SchemaPayload schema;
  schema.schema_id = 10;
  schema.revision = 1;
  schema.channel = text("sensor");
  schema.field_count = 1;
  schema.fields = &descriptor;
  return schema;
}

static void makeAck(uint8_t output[kAckBytes], const RunId& id,
                    uint32_t frame_sequence, uint32_t request_crc,
                    AckStatus status, uint16_t flags, uint32_t retry_ms = 0) {
  memset(output, 0, kAckBytes);
  memcpy(output, "ALYA", 4);
  output[4] = 1;
  output[5] = static_cast<uint8_t>(status);
  putU16(output + 6, flags);
  putU16(output + 8, kAckBytes);
  putU32(output + 12, frame_sequence);
  putU32(output + 16, frame_sequence + 1);
  putU32(output + 20, retry_ms);
  memcpy(output + 24, id.bytes, sizeof(id.bytes));
  putU32(output + 44, request_crc);
  putU32(output + 40, crc32c(output, kAckBytes));
}

static bool ackFront(Core& core, AckStatus status = ACK_ACCEPTED,
                     uint16_t flags = ACK_FLAG_ACCEPTED,
                     uint32_t retry_ms = 0,
                     AckDisposition* disposition = NULL, Ack* decoded = NULL) {
  FrameView frame;
  CHECK(core.acquireInFlight(&frame));
  uint8_t ack[kAckBytes];
  makeAck(ack, core.runId(), frame.frame_seq, frame.crc32c, status, flags,
          retry_ms);
  const AckDisposition result = core.handleAck(ack, sizeof(ack), decoded);
  if (disposition != NULL) {
    *disposition = result;
  }
  return true;
}

static bool controlCorruptionFaults(FrameType target, uint8_t run_seed) {
  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(run_seed), 1000, runBegin()) == COMMIT_OK);
  if (target == CAPABILITIES) {
    CHECK(core.commitCapabilities(capabilities()) == COMMIT_OK);
  } else if (target == SCHEMA) {
    CHECK(core.commitSchema(oneFieldSchema(FIELD_U32)) == COMMIT_OK);
  } else if (target == UTC_ANCHOR) {
    CHECK(core.pollMicros(1100));
    UtcAnchorPayload anchor;
    anchor.anchor_id = 1;
    anchor.source = ANCHOR_AUTHENTICATED_HOST;
    anchor.quality = ANCHOR_APPROXIMATE;
    anchor.uncertainty_us = 5000;
    anchor.mono_us = 1100;
    anchor.utc_ns = UINT64_C(1786400000000000000);
    anchor.frequency_error_ppb = INT32_MIN;
    CHECK(core.commitUtcAnchor(anchor) == COMMIT_OK);
  } else if (target == GAP) {
    GapPayload gap;
    memset(&gap, 0, sizeof(gap));
    gap.reason = GAP_CLOCK_REGRESSION;
    gap.action = GAP_DROP_NEWEST;
    gap.first_lost_sample_seq = UINT32_MAX;
    gap.first_lost_frame_seq = UINT32_MAX;
    gap.mono_start_us = 1000;
    gap.mono_end_us = 1000;
    gap.detail = 999;
    CHECK(CoreTestAccess::enqueueGap(core, gap));
    CHECK(core.flushPendingGap() == COMMIT_OK);
  } else if (target == RUN_END) {
    CHECK(core.end(1100, RUN_END_EXPLICIT, 0) == COMMIT_OK);
  } else if (target != RUN_BEGIN) {
    return false;
  }

  for (size_t attempt = 0; attempt < kJournalSlotCount; ++attempt) {
    FrameView frame;
    CHECK(core.acquireInFlight(&frame));
    if (frame.bytes[5] == static_cast<uint8_t>(target)) {
      uint8_t* corrupt = const_cast<uint8_t*>(frame.bytes);
      corrupt[kFrameHeaderBytes] ^= 1;
      CHECK(!core.acquireInFlight(&frame));
      CHECK(core.state() == CORE_FAULTED);
      CHECK(core.stats().frame.corrupt_frames == 1);
      CHECK(core.stats().frame.dropped_frames == 0);
      CHECK(core.pendingGapCount() == 0);
      return true;
    }
    CHECK(ackFront(core));
  }
  return false;
}

static bool goldenVectors() {
  static const char kFrameHex[] =
      "414c59310101000040001c0000000000000102030405060708090a0b0c0d0e0f"
      "01000600000000000000000000000000000000000000000000000000747ccf68"
      "0903000101000000e803000000000000756e6f2d72342d3031667731";
  static const char kAckHex[] =
      "414c59410100010030000000000000000100000000000000000102030405060708"
      "090a0b0c0d0e0f21eb0099747ccf68";
  const std::vector<uint8_t> expected_frame = fromHex(kFrameHex);
  const std::vector<uint8_t> expected_ack = fromHex(kAckHex);
  uint8_t frame[kUnoFrameBytes];
  size_t frame_size = 0;
  CHECK(encodeRunBeginFrame(frame, sizeof(frame), frameContext(), runBegin(),
                            &frame_size) == ENCODE_OK);
  CHECK(frame_size == expected_frame.size());
  CHECK(memcmp(frame, &expected_frame[0], frame_size) == 0);
  CHECK(crc32c(reinterpret_cast<const uint8_t*>("123456789"), 9) ==
        0xe3069283u);
  FrameInfo info;
  CHECK(inspectFrame(frame, frame_size, &info) == ENCODE_OK);
  CHECK(info.type == RUN_BEGIN);
  CHECK(info.crc32c == 0x68cf7c74u);
  Ack ack;
  CHECK(decodeAndValidateAck(&expected_ack[0], expected_ack.size(),
                            frameContext().run_id, 0, info.crc32c,
                            &ack) == ACK_VALID);
  CHECK(ack.status == ACK_ACCEPTED);
  CHECK(ack.flags == ACK_FLAG_ACCEPTED);
  CHECK(ack.lowest_unresolved_seq == 1);
  CHECK(ack.crc32c == 0x9900eb21u);
  return true;
}

static bool allPayloadAndFrameEncoders() {
  uint8_t frame[kProtocolMaxFrameBytes];
  size_t size = 0;
  FrameInfo info;
  const FrameContext context = frameContext();

  CHECK(encodeCapabilitiesFrame(frame, sizeof(frame), context, capabilities(),
                                &size) == ENCODE_OK);
  CHECK(inspectFrame(frame, size, &info) == ENCODE_OK);
  CHECK(info.type == CAPABILITIES);

  const SchemaPayload schema = oneFieldSchema();
  CHECK(encodeSchemaFrame(frame, sizeof(frame), context, schema, &size) ==
        ENCODE_OK);
  CHECK(inspectFrame(frame, size, &info) == ENCODE_OK);
  CHECK(info.type == SCHEMA);

  UtcAnchorPayload anchor;
  anchor.anchor_id = 1;
  anchor.source = ANCHOR_AUTHENTICATED_HOST;
  anchor.quality = ANCHOR_APPROXIMATE;
  anchor.uncertainty_us = 5000;
  anchor.mono_us = 2000;
  anchor.utc_ns = UINT64_C(1786400000000000000);
  anchor.frequency_error_ppb = INT32_MIN;
  CHECK(encodeUtcAnchorFrame(frame, sizeof(frame), context, anchor, &size) ==
        ENCODE_OK);
  CHECK(size == 96);
  CHECK(inspectFrame(frame, size, &info) == ENCODE_OK);
  CHECK(info.type == UTC_ANCHOR);

  FieldType types[3] = {FIELD_BOOL, FIELD_U32, FIELD_F32};
  SampleFieldValue values[3];
  memset(values, 0, sizeof(values));
  values[0].present = 1;
  values[0].value.boolean_value = 1;
  values[1].present = 1;
  values[1].value.u32_value = 0x12345678u;
  values[2].present = 1;
  values[2].value.f32_value = std::numeric_limits<float>::infinity();
  SampleRecordPayload record;
  record.schema_id = 10;
  record.revision = 1;
  record.anchor_id = 0;
  record.sample_seq = 7;
  record.mono_us = 2500;
  record.field_count = 3;
  record.field_types = types;
  record.fields = values;
  SamplesPayload samples;
  samples.base_mono_us = 2500;
  samples.record_count = 1;
  samples.records = &record;
  CHECK(encodeSamplesFrame(frame, sizeof(frame), context, samples, &size) ==
        ENCODE_OK);
  CHECK(inspectFrame(frame, size, &info) == ENCODE_OK);
  CHECK(info.type == SAMPLES);
  CHECK(getU16(frame + kFrameHeaderBytes + 16 + 16) == 0x0003);
  CHECK(frame[kFrameHeaderBytes + 16 + 20 + 5] == 0);
  CHECK(frame[kFrameHeaderBytes + 16 + 20 + 6] == 0);
  CHECK(frame[kFrameHeaderBytes + 16 + 20 + 7] == 0);
  CHECK(frame[kFrameHeaderBytes + 16 + 20 + 8] == 0);

  GapPayload gap;
  memset(&gap, 0, sizeof(gap));
  gap.reason = GAP_JOURNAL_FULL;
  gap.action = GAP_DROP_NEWEST;
  gap.first_lost_sample_seq = 5;
  gap.lost_sample_count = 2;
  gap.first_lost_frame_seq = UINT32_MAX;
  gap.mono_start_us = 3000;
  gap.mono_end_us = 3100;
  gap.detail = 9;
  CHECK(encodeGapFrame(frame, sizeof(frame), context, gap, &size) == ENCODE_OK);
  CHECK(size == 104);
  CHECK(inspectFrame(frame, size, &info) == ENCODE_OK);
  CHECK(info.type == GAP);

  RunEndPayload end;
  memset(&end, 0, sizeof(end));
  end.reason = RUN_END_EXPLICIT;
  end.mono_end_us = 4000;
  end.attempted_samples = 5;
  end.encoded_samples = 4;
  end.dropped_samples = 1;
  CHECK(encodeRunEndFrame(frame, sizeof(frame), context, end, &size) ==
        ENCODE_OK);
  CHECK(size == 104);
  CHECK(inspectFrame(frame, size, &info) == ENCODE_OK);
  CHECK(info.type == RUN_END);
  return true;
}

static bool boundsReservedAndCorruption() {
  uint8_t frame[kProtocolMaxFrameBytes + 1];
  size_t size = 0;
  CHECK(encodeRunBeginFrame(frame, sizeof(frame), frameContext(), runBegin(),
                            &size) == ENCODE_OK);
  FrameInfo info;
  CHECK(inspectFrame(frame, size - 1, &info) != ENCODE_OK);
  frame[70] ^= 0x80;
  CHECK(inspectFrame(frame, size, &info) != ENCODE_OK);

  CHECK(encodeRunBeginFrame(frame, sizeof(frame), frameContext(), runBegin(),
                            &size) == ENCODE_OK);
  frame[kFrameHeaderBytes + 5] = 1;
  memset(frame + 60, 0, 4);
  putU32(frame + 60, crc32c(frame, size));
  CHECK(inspectFrame(frame, size, &info) != ENCODE_OK);

  CHECK(encodeRunBeginFrame(frame, sizeof(frame), frameContext(), runBegin(),
                            &size) == ENCODE_OK);
  putU32(frame + 12, UINT32_MAX);
  memset(frame + 60, 0, 4);
  putU32(frame + 60, crc32c(frame, size));
  CHECK(inspectFrame(frame, size, &info) != ENCODE_OK);

  uint8_t too_large_payload[961];
  memset(too_large_payload, 0, sizeof(too_large_payload));
  CHECK(encodeFrame(frame, sizeof(frame), GAP, frameContext(),
                    too_large_payload, sizeof(too_large_payload), &size) ==
        ENCODE_FRAME_TOO_LARGE);

  RunBeginPayload invalid = runBegin();
  invalid.device = text("bad.device");
  CHECK(encodeRunBeginFrame(frame, sizeof(frame), frameContext(), invalid,
                            &size) == ENCODE_INVALID_TEXT);
  RunEndPayload end;
  memset(&end, 0, sizeof(end));
  end.reason = RUN_END_EXPLICIT;
  end.flags = 1;
  CHECK(encodeRunEndPayload(frame, sizeof(frame), end, &size) ==
        ENCODE_INVALID_FIELD);
  return true;
}

static bool ackValidationAndRetryIdentity() {
  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  FrameView first;
  CHECK(core.acquireInFlight(&first));
  std::vector<uint8_t> retained(first.bytes, first.bytes + first.size);
  core.noteRetryAttempt();
  FrameView retried;
  CHECK(core.acquireInFlight(&retried));
  CHECK(retried.size == retained.size());
  CHECK(memcmp(retried.bytes, &retained[0], retained.size()) == 0);
  CHECK(core.stats().frame.retries == 1);

  uint8_t ack[kAckBytes];
  makeAck(ack, core.runId(), first.frame_seq, first.crc32c, ACK_BUSY,
          ACK_FLAG_RETRYABLE, 4321);
  Ack decoded;
  CHECK(core.handleAck(ack, sizeof(ack), &decoded) == ACK_RETAINED_RETRY);
  CHECK(decoded.retry_after_ms == 4321);
  CHECK(core.hasInFlight());

  ack[10] ^= 1;
  CHECK(core.handleAck(ack, sizeof(ack), &decoded) == ACK_REJECTED_MALFORMED);
  CHECK(core.hasInFlight());

  static const char kCloudDuplicateAckHex[] =
      "414c59410101030030000000000000000100000000000000000102030405060708"
      "090a0b0c0d0e0f61bb18e9747ccf68";
  const std::vector<uint8_t> cloud_duplicate = fromHex(kCloudDuplicateAckHex);
  CHECK(cloud_duplicate.size() == kAckBytes);
  CHECK(core.handleAck(&cloud_duplicate[0], cloud_duplicate.size(), &decoded) ==
        ACK_RECLAIMED);
  CHECK(decoded.status == ACK_DUPLICATE);
  CHECK(decoded.flags == (ACK_FLAG_ACCEPTED | ACK_FLAG_DUPLICATE));
  CHECK(!core.hasInFlight());
  CHECK(core.handleAck(&cloud_duplicate[0], cloud_duplicate.size(), &decoded) ==
        ACK_NO_IN_FLIGHT);

  RunId wrong = runId(1);
  makeAck(ack, wrong, 0, first.crc32c, ACK_ACCEPTED, ACK_FLAG_ACCEPTED);
  CHECK(decodeAndValidateAck(ack, sizeof(ack), runId(), 0, first.crc32c,
                            &decoded) == ACK_WRONG_RUN);
  makeAck(ack, runId(), 1, first.crc32c, ACK_ACCEPTED, ACK_FLAG_ACCEPTED);
  CHECK(decodeAndValidateAck(ack, sizeof(ack), runId(), 0, first.crc32c,
                            &decoded) == ACK_WRONG_SEQUENCE);
  makeAck(ack, runId(), 0, first.crc32c + 1, ACK_ACCEPTED,
          ACK_FLAG_ACCEPTED);
  CHECK(decodeAndValidateAck(ack, sizeof(ack), runId(), 0, first.crc32c,
                            &decoded) == ACK_WRONG_REQUEST_CRC);
  return true;
}

static bool ackStatusPrecedesRetryFlag() {
  uint8_t ack[kAckBytes];
  FrameView frame;
  Ack decoded;

  FixedJournal auth_journal;
  Core auth(auth_journal);
  CHECK(auth.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CHECK(auth.acquireInFlight(&frame));
  makeAck(ack, auth.runId(), frame.frame_seq, frame.crc32c,
          ACK_AUTHENTICATION_FAILURE, ACK_FLAG_RETRYABLE);
  CHECK(auth.handleAck(ack, sizeof(ack), &decoded) ==
        ACK_ENTERED_AUTH_BLOCKED);
  CHECK(auth.state() == CORE_AUTH_BLOCKED);

  FixedJournal stale_journal;
  Core stale(stale_journal);
  CHECK(stale.begin(runId(16), 1000, runBegin()) == COMMIT_OK);
  CHECK(stale.acquireInFlight(&frame));
  makeAck(ack, stale.runId(), frame.frame_seq, frame.crc32c,
          ACK_RUN_FINALIZED, ACK_FLAG_RETRYABLE | ACK_FLAG_RUN_TERMINAL);
  CHECK(stale.handleAck(ack, sizeof(ack), &decoded) == ACK_ENTERED_STALE);
  CHECK(stale.state() == CORE_STALE);

  const AckStatus fatal_statuses[] = {
      ACK_SEQUENCE_CONFLICT, ACK_INVALID_SAMPLE,
      ACK_PROTOCOL_FORMAT_CONFLICT, ACK_SCHEMA_CONFLICT};
  for (size_t i = 0; i < sizeof(fatal_statuses) / sizeof(fatal_statuses[0]);
       ++i) {
    FixedJournal fatal_journal;
    Core fatal(fatal_journal);
    CHECK(fatal.begin(runId(static_cast<uint8_t>(32 + i * 16)), 1000,
                      runBegin()) == COMMIT_OK);
    CHECK(fatal.acquireInFlight(&frame));
    makeAck(ack, fatal.runId(), frame.frame_seq, frame.crc32c,
            fatal_statuses[i], ACK_FLAG_RETRYABLE);
    CHECK(fatal.handleAck(ack, sizeof(ack), &decoded) == ACK_ENTERED_FAULT);
    CHECK(fatal.state() == CORE_FAULTED);
  }

  FixedJournal busy_journal;
  Core busy(busy_journal);
  CHECK(busy.begin(runId(96), 1000, runBegin()) == COMMIT_OK);
  CHECK(busy.acquireInFlight(&frame));
  makeAck(ack, busy.runId(), frame.frame_seq, frame.crc32c, ACK_BUSY, 0,
          250);
  CHECK(busy.handleAck(ack, sizeof(ack), &decoded) == ACK_RETAINED_RETRY);
  CHECK(busy.state() == CORE_CAPTURING);

  FixedJournal accepted_retry_journal;
  Core accepted_retry(accepted_retry_journal);
  CHECK(accepted_retry.begin(runId(104), 1000, runBegin()) == COMMIT_OK);
  CHECK(accepted_retry.acquireInFlight(&frame));
  makeAck(ack, accepted_retry.runId(), frame.frame_seq, frame.crc32c,
          ACK_ACCEPTED, ACK_FLAG_ACCEPTED | ACK_FLAG_RETRYABLE);
  CHECK(accepted_retry.handleAck(ack, sizeof(ack), &decoded) == ACK_RECLAIMED);
  CHECK(accepted_retry.state() == CORE_CAPTURING);

  FixedJournal contradictory_journal;
  Core contradictory(contradictory_journal);
  CHECK(contradictory.begin(runId(112), 1000, runBegin()) == COMMIT_OK);
  CHECK(contradictory.acquireInFlight(&frame));
  makeAck(ack, contradictory.runId(), frame.frame_seq, frame.crc32c,
          ACK_ACCEPTED, ACK_FLAG_RETRYABLE);
  CHECK(contradictory.handleAck(ack, sizeof(ack), &decoded) ==
        ACK_ENTERED_FAULT);
  return true;
}

static bool samplesClockAndSchema() {
  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  const SchemaPayload schema = oneFieldSchema(FIELD_F32);
  CHECK(core.commitSchema(schema) == COMMIT_OK);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.f32_value = 21.5f;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;
  const SampleCommitResult first = core.commitSample(1100, sample);
  CHECK(first.status == SAMPLE_COMMITTED);
  CHECK(first.sample_seq == 0);
  CHECK(core.hasBuilder());
  const SampleCommitResult regressed = core.commitSample(1099, sample);
  CHECK(regressed.status == SAMPLE_CLOCK_REGRESSION);
  CHECK(regressed.sample_seq == 1);
  CHECK(core.monotonicMicros() == 1100);
  CHECK(core.pendingGap().pending);
  CHECK(core.monotonicMicros() == 1100);
  CHECK(core.pendingGap().payload.mono_start_us == 1100);
  CHECK(core.pendingGap().payload.mono_end_us == 1100);
  CHECK(core.pendingGap().payload.reason == GAP_CLOCK_REGRESSION);
  CHECK(core.flushSamples() == COMMIT_OK);
  CHECK(!core.hasBuilder());
  CHECK(core.stats().attempted_samples == 2);
  CHECK(core.stats().encoded_samples == 1);
  CHECK(core.stats().frame.dropped_samples == 1);

  bool found_samples = false;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    const JournalSlot& slot = journal.slot(i);
    if (slot.state != JOURNAL_EMPTY && slot.bytes[5] == SAMPLES) {
      found_samples = true;
      CHECK(getU16(slot.bytes + kFrameHeaderBytes) == 1);
      CHECK(getU32(slot.bytes + kFrameHeaderBytes + 16 + 8) == 0);
      CHECK(getU32(slot.bytes + kFrameHeaderBytes + 16 + 12) == 0);
      CHECK(getU16(slot.bytes + kFrameHeaderBytes + 16 + 16) == 1);
    }
  }
  CHECK(found_samples);

  MicrosExtender extender;
  extender.reset(0xfffffff0u);
  uint64_t extended = 0;
  CHECK(extender.update(0x00000010u, &extended));
  CHECK(extended == UINT64_C(0x100000010));
  CHECK(!extender.update(0x0000000fu, &extended));
  CHECK(extender.value() == UINT64_C(0x100000010));
  MicrosExtender boundary;
  boundary.reset(0);
  CHECK(boundary.update(kMaximumMicrosPollIntervalUs, &extended));
  MicrosExtender too_late;
  too_late.reset(0);
  CHECK(!too_late.update(kMaximumMicrosPollIntervalUs + 1u, &extended));
  return true;
}

static bool journalOverflowAndGapReserve() {
  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  CHECK(core.commitSchema(schema) == COMMIT_OK);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(core.journalUsed() == 5);

  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.u32_value = 9;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;
  const SampleCommitResult dropped = core.commitSample(1100, sample);
  CHECK(dropped.status == SAMPLE_DROPPED_NEWEST);
  CHECK(dropped.sample_seq == 0);
  CHECK(core.pendingGap().pending);
  CHECK(core.monotonicMicros() == 1100);
  CHECK(core.pendingGap().payload.mono_start_us == 1100);
  CHECK(core.pendingGap().payload.mono_end_us == 1100);
  CHECK(core.stats().frame.dropped_samples == 1);
  CHECK(core.stats().frame.backpressure_events == 1);
  CHECK(core.flushPendingGap() == COMMIT_OK);
  CHECK(core.journalUsed() == 6);
  CHECK(!core.pendingGap().pending);
  bool found_gap = false;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    const JournalSlot& slot = journal.slot(i);
    if (slot.state != JOURNAL_EMPTY && slot.bytes[5] == GAP) {
      found_gap = true;
      CHECK(slot.bytes[kFrameHeaderBytes] == GAP_JOURNAL_FULL);
      CHECK(getU32(slot.bytes + kFrameHeaderBytes + 4) == 0);
      CHECK(getU32(slot.bytes + kFrameHeaderBytes + 8) == 1);
    }
  }
  CHECK(found_gap);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_WOULD_BLOCK);

  FixedJournal blocking_journal;
  Core blocking(blocking_journal);
  CHECK(blocking.begin(runId(16), 1000,
                       runBegin(LOSS_INTOLERANT)) == COMMIT_OK);
  CHECK(blocking.commitSchema(schema) == COMMIT_OK);
  CHECK(blocking.commitCapabilities(capabilities(LOSS_INTOLERANT)) ==
        COMMIT_OK);
  CHECK(blocking.commitCapabilities(capabilities(LOSS_INTOLERANT)) ==
        COMMIT_OK);
  CHECK(blocking.commitCapabilities(capabilities(LOSS_INTOLERANT)) ==
        COMMIT_OK);
  const SampleCommitResult would_block = blocking.commitSample(1100, sample);
  CHECK(would_block.status == SAMPLE_WOULD_BLOCK);
  CHECK(would_block.sample_seq == UINT32_MAX);
  CHECK(blocking.nextSampleSequence() == 0);
  CHECK(!blocking.pendingGap().pending);
  CHECK(blocking.monotonicMicros() == 1100);

  FixedJournal wrap_journal;
  Core wrap(wrap_journal);
  CHECK(wrap.begin(runId(32), 0xfffffff0u,
                   runBegin(VOLATILE_BEST_EFFORT, 0xfffffff0u)) == COMMIT_OK);
  CHECK(wrap.commitSchema(schema) == COMMIT_OK);
  CHECK(wrap.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(wrap.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(wrap.commitCapabilities(capabilities()) == COMMIT_OK);
  const SampleCommitResult wrap_drop = wrap.commitSample(0x10u, sample);
  CHECK(wrap_drop.status == SAMPLE_DROPPED_NEWEST);
  CHECK(wrap.monotonicMicros() == UINT64_C(0x100000010));
  CHECK(wrap.pendingGap().payload.mono_start_us == UINT64_C(0x100000010));
  return true;
}

static bool capabilitiesMatchFixedProfile() {
  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  const CapabilitiesPayload valid = capabilities();
  CapabilitiesPayload changed = valid;
  changed.active_reliability = LOSS_INTOLERANT;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.maximum_frame_bytes = 769;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.journal_slots = 5;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.journal_slot_bytes = 776;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.maximum_schemas = kCoreMaxSchemas - 1;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.maximum_fields_per_schema = kMaxFieldsPerSchema - 1;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.journal_kind = JOURNAL_INTERNAL_FLASH;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  changed = valid;
  changed.capability_bits |= CAPABILITY_PERSISTENT_JOURNAL;
  CHECK(core.commitCapabilities(changed) == COMMIT_REJECTED);
  CHECK(core.journalUsed() == 1);
  CHECK(core.commitCapabilities(valid) == COMMIT_OK);

  FixedJournal strict_journal;
  Core strict(strict_journal);
  CHECK(strict.begin(runId(16), 1000, runBegin(LOSS_INTOLERANT)) == COMMIT_OK);
  changed = capabilities(LOSS_INTOLERANT);
  changed.capability_bits &= ~static_cast<uint64_t>(CAPABILITY_BACKPRESSURE);
  CHECK(strict.commitCapabilities(changed) == COMMIT_REJECTED);
  CHECK(strict.commitCapabilities(capabilities(LOSS_INTOLERANT)) == COMMIT_OK);

  FixedJournal recoverable_journal;
  Core recoverable(recoverable_journal);
  CHECK(recoverable.begin(runId(32), 1000, runBegin(RECOVERABLE)) ==
        COMMIT_REJECTED);
  CHECK(recoverable.state() == CORE_IDLE);
  CHECK(recoverable.journalUsed() == 0);

  FixedJournal portable_journal;
  Core portable(portable_journal);
  CHECK(portable.begin(runId(48), 1000, runBegin()) == COMMIT_OK);
  changed = capabilities();
  changed.board_code = 99;
  changed.monotonic_resolution_us = 8;
  changed.scheduler_kind = SCHEDULER_THREADED;
  CHECK(portable.commitCapabilities(changed) == COMMIT_OK);
  return true;
}

static bool pendingGapsRemainTruthful() {
  const SchemaPayload schema = oneFieldSchema(FIELD_BOOL);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.boolean_value = 1;
  SampleInput sample;
  sample.schema_id = 999;
  sample.revision = 1;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;

  FixedJournal detail_journal;
  Core detail_core(detail_journal);
  CHECK(detail_core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CHECK(detail_core.commitSchema(schema) == COMMIT_OK);
  CHECK(detail_core.commitSample(1100, sample).status ==
        SAMPLE_UNKNOWN_SCHEMA);
  sample.schema_id = schema.schema_id;
  sample.field_count = 0;
  CHECK(detail_core.commitSample(1110, sample).status ==
        SAMPLE_ENCODER_REJECTED);
  CHECK(detail_core.pendingGapCount() == 2);
  CHECK(CoreTestAccess::pendingGap(detail_core, 0).payload.reason ==
        GAP_ENCODER_REJECTION);
  CHECK(CoreTestAccess::pendingGap(detail_core, 0).payload.detail == 1);
  CHECK(CoreTestAccess::pendingGap(detail_core, 1).payload.reason ==
        GAP_ENCODER_REJECTION);
  CHECK(CoreTestAccess::pendingGap(detail_core, 1).payload.detail == 2);
  CHECK(detail_core.flushPendingGap() == COMMIT_OK);
  CHECK(detail_core.pendingGapCount() == 1);
  CHECK(detail_core.pendingGap().payload.detail == 2);
  CHECK(detail_core.flushPendingGap() == COMMIT_OK);
  CHECK(detail_core.pendingGapCount() == 0);
  size_t gap_frames = 0;
  bool detail_one = false;
  bool detail_two = false;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    const JournalSlot& slot = detail_journal.slot(i);
    if (slot.state != JOURNAL_EMPTY && slot.bytes[5] == GAP) {
      ++gap_frames;
      const uint32_t detail = getU32(slot.bytes + kFrameHeaderBytes + 36);
      detail_one = detail_one || detail == 1;
      detail_two = detail_two || detail == 2;
    }
  }
  CHECK(gap_frames == 2);
  CHECK(detail_one && detail_two);

  FixedJournal action_journal;
  Core action_core(action_journal);
  CHECK(action_core.begin(runId(8), 1000, runBegin()) == COMMIT_OK);
  GapPayload action_gap;
  memset(&action_gap, 0, sizeof(action_gap));
  action_gap.reason = GAP_JOURNAL_FULL;
  action_gap.action = GAP_DROP_NEWEST;
  action_gap.first_lost_sample_seq = 4;
  action_gap.lost_sample_count = 1;
  action_gap.first_lost_frame_seq = UINT32_MAX;
  action_gap.mono_start_us = 1010;
  action_gap.mono_end_us = 1010;
  CHECK(CoreTestAccess::enqueueGap(action_core, action_gap));
  action_gap.action = GAP_FAULTED;
  action_gap.first_lost_sample_seq = 5;
  CHECK(CoreTestAccess::enqueueGap(action_core, action_gap));
  CHECK(action_core.pendingGapCount() == 2);
  CHECK(CoreTestAccess::pendingGap(action_core, 0).payload.action ==
        GAP_DROP_NEWEST);
  CHECK(CoreTestAccess::pendingGap(action_core, 1).payload.action ==
        GAP_FAULTED);

  FixedJournal mixed_journal;
  Core mixed(mixed_journal);
  CHECK(mixed.begin(runId(16), 1000, runBegin()) == COMMIT_OK);
  CHECK(mixed.commitSchema(schema) == COMMIT_OK);
  sample.schema_id = 999;
  sample.field_count = 1;
  CHECK(mixed.commitSample(1100, sample).status == SAMPLE_UNKNOWN_SCHEMA);
  CHECK(mixed.commitSample(1099, sample).status == SAMPLE_CLOCK_REGRESSION);
  CHECK(mixed.pendingGapCount() == 2);
  CHECK(CoreTestAccess::pendingGap(mixed, 0).payload.reason ==
        GAP_ENCODER_REJECTION);
  CHECK(CoreTestAccess::pendingGap(mixed, 1).payload.reason ==
        GAP_CLOCK_REGRESSION);
  CHECK(mixed.commitSample(1098, sample).status == SAMPLE_FAULTED);
  CHECK(mixed.state() == CORE_FAULTED);
  CHECK(mixed.pendingGapCount() == 2);
  return true;
}

static bool journalCorruptionAndReset() {
  FixedJournal control_journal;
  Core control(control_journal);
  CHECK(control.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  FrameView frame;
  CHECK(control.acquireInFlight(&frame));
  uint8_t* corrupt = const_cast<uint8_t*>(frame.bytes);
  corrupt[kFrameHeaderBytes] ^= 1;
  CHECK(!control.acquireInFlight(&frame));
  CHECK(control.state() == CORE_FAULTED);
  CHECK(control.stats().frame.corrupt_frames == 1);
  CHECK(control.stats().frame.dropped_frames == 0);
  CHECK(control.pendingGapCount() == 0);
  CHECK(control.journalUsed() == 1);

  const FrameType dependency_types[] = {CAPABILITIES, SCHEMA, UTC_ANCHOR, GAP,
                                        RUN_END};
  for (size_t i = 0;
       i < sizeof(dependency_types) / sizeof(dependency_types[0]); ++i) {
    CHECK(controlCorruptionFaults(
        dependency_types[i], static_cast<uint8_t>(48 + i * 24)));
  }

  FixedJournal empty_state_control_journal;
  Core empty_state_control(empty_state_control_journal);
  CHECK(empty_state_control.begin(runId(8), 1000, runBegin()) == COMMIT_OK);
  const size_t begin_slot =
      CoreTestAccess::findSlot(empty_state_control, RUN_BEGIN);
  CHECK(begin_slot < kJournalSlotCount);
  CoreTestAccess::slot(empty_state_control, begin_slot).state = JOURNAL_EMPTY;
  CHECK(!empty_state_control.acquireInFlight(&frame));
  CHECK(empty_state_control.state() == CORE_FAULTED);
  CHECK(empty_state_control.stats().frame.corrupt_frames == 1);

  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.u32_value = 7;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;

  FixedJournal sample_journal;
  Core sample_core(sample_journal);
  CHECK(sample_core.begin(runId(16), 1000, runBegin()) == COMMIT_OK);
  CHECK(sample_core.commitSchema(schema) == COMMIT_OK);
  CHECK(sample_core.commitSample(1100, sample).status == SAMPLE_COMMITTED);
  CHECK(sample_core.flushSamples() == COMMIT_OK);
  CHECK(ackFront(sample_core));
  CHECK(ackFront(sample_core));
  CHECK(sample_core.acquireInFlight(&frame));
  CHECK(frame.bytes[5] == SAMPLES);
  corrupt = const_cast<uint8_t*>(frame.bytes);
  corrupt[kFrameHeaderBytes + 20] ^= 1;
  CHECK(!sample_core.acquireInFlight(&frame));
  CHECK(sample_core.state() == CORE_CAPTURING);
  CHECK(sample_core.stats().frame.corrupt_frames == 1);
  CHECK(sample_core.stats().frame.dropped_frames == 1);
  CHECK(sample_core.stats().frame.dropped_samples == 1);
  CHECK(sample_core.pendingGapCount() == 1);
  CHECK(sample_core.pendingGap().payload.reason == GAP_JOURNAL_CRC_FAILURE);
  CHECK(sample_core.pendingGap().payload.first_lost_frame_seq == 2);
  CHECK(sample_core.pendingGap().payload.lost_frame_count == 1);
  CHECK(sample_core.pendingGap().payload.first_lost_sample_seq == 0);
  CHECK(sample_core.pendingGap().payload.lost_sample_count == 1);
  CHECK(sample_core.pendingGap().payload.mono_start_us == 1100);

  FixedJournal empty_state_sample_journal;
  Core empty_state_sample(empty_state_sample_journal);
  CHECK(empty_state_sample.begin(runId(24), 1000, runBegin()) == COMMIT_OK);
  CHECK(empty_state_sample.commitSchema(schema) == COMMIT_OK);
  CHECK(empty_state_sample.commitSample(1100, sample).status ==
        SAMPLE_COMMITTED);
  CHECK(empty_state_sample.flushSamples() == COMMIT_OK);
  CHECK(ackFront(empty_state_sample));
  CHECK(ackFront(empty_state_sample));
  const size_t empty_sample_slot =
      CoreTestAccess::findSlot(empty_state_sample, SAMPLES);
  CHECK(empty_sample_slot < kJournalSlotCount);
  CoreTestAccess::slot(empty_state_sample, empty_sample_slot).state =
      JOURNAL_EMPTY;
  CHECK(!empty_state_sample.acquireInFlight(&frame));
  CHECK(empty_state_sample.state() == CORE_CAPTURING);
  CHECK(empty_state_sample.stats().frame.corrupt_frames == 1);
  CHECK(empty_state_sample.pendingGapCount() == 1);
  CHECK(empty_state_sample.pendingGap().payload.first_lost_sample_seq == 0);
  CHECK(empty_state_sample.pendingGap().payload.lost_sample_count == 1);

  FixedJournal noncontiguous_journal;
  Core noncontiguous(noncontiguous_journal);
  CHECK(noncontiguous.begin(runId(40), 1000, runBegin()) == COMMIT_OK);
  CHECK(noncontiguous.commitSchema(schema) == COMMIT_OK);
  CHECK(noncontiguous.commitSample(1100, sample).status == SAMPLE_COMMITTED);
  SampleInput unknown = sample;
  unknown.schema_id = 999;
  CHECK(noncontiguous.commitSample(1110, unknown).status ==
        SAMPLE_UNKNOWN_SCHEMA);
  CHECK(noncontiguous.commitSample(1120, sample).status == SAMPLE_COMMITTED);
  CHECK(noncontiguous.flushSamples() == COMMIT_OK);
  CHECK(ackFront(noncontiguous));
  CHECK(ackFront(noncontiguous));
  CHECK(noncontiguous.acquireInFlight(&frame));
  corrupt = const_cast<uint8_t*>(frame.bytes);
  corrupt[kFrameHeaderBytes + 20] ^= 1;
  CHECK(!noncontiguous.acquireInFlight(&frame));
  CHECK(noncontiguous.state() == CORE_CAPTURING);
  CHECK(noncontiguous.pendingGapCount() == 2);
  const PendingGap& noncontiguous_loss =
      CoreTestAccess::pendingGap(noncontiguous, 1);
  CHECK(noncontiguous_loss.payload.reason == GAP_JOURNAL_CRC_FAILURE);
  CHECK(noncontiguous_loss.payload.first_lost_sample_seq == UINT32_MAX);
  CHECK(noncontiguous_loss.payload.lost_sample_count == 2);

  FixedJournal strict_journal;
  Core strict(strict_journal);
  CHECK(strict.begin(runId(32), 1000, runBegin(LOSS_INTOLERANT)) == COMMIT_OK);
  CHECK(strict.commitSchema(schema) == COMMIT_OK);
  CHECK(strict.commitSample(1100, sample).status == SAMPLE_COMMITTED);
  CHECK(strict.flushSamples() == COMMIT_OK);
  CHECK(ackFront(strict));
  CHECK(ackFront(strict));
  CHECK(strict.acquireInFlight(&frame));
  corrupt = const_cast<uint8_t*>(frame.bytes);
  corrupt[kFrameHeaderBytes + 20] ^= 1;
  CHECK(!strict.acquireInFlight(&frame));
  CHECK(strict.state() == CORE_FAULTED);
  CHECK(strict.stats().frame.corrupt_frames == 1);
  CHECK(strict.stats().frame.dropped_frames == 0);
  CHECK(strict.pendingGapCount() == 0);

  control.reset();
  CHECK(control.state() == CORE_IDLE);
  CHECK(control.journalUsed() == 0);
  CHECK(control.nextFrameSequence() == 0);
  CHECK(control.nextSampleSequence() == 0);
  CHECK(control.stats().frame.corrupt_frames == 0);
  CHECK(control.pendingGapCount() == 0);
  const RunId new_id = runId(32);
  CHECK(control.begin(new_id, 2000,
                      runBegin(VOLATILE_BEST_EFFORT, 2000)) ==
        COMMIT_OK);
  CHECK(control.nextFrameSequence() == 1);
  CHECK(memcmp(control.runId().bytes, new_id.bytes, sizeof(new_id.bytes)) == 0);
  return true;
}

static bool anchorsEndAndTerminalStates() {
  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CHECK(core.pollMicros(1200));
  UtcAnchorPayload host;
  host.anchor_id = 1;
  host.source = ANCHOR_AUTHENTICATED_HOST;
  host.quality = ANCHOR_APPROXIMATE;
  host.uncertainty_us = 5000;
  host.mono_us = 1150;
  host.utc_ns = UINT64_C(1786400000000000000);
  host.frequency_error_ppb = INT32_MIN;
  UtcAnchorPayload zero_utc = host;
  zero_utc.utc_ns = 0;
  CHECK(core.commitUtcAnchor(zero_utc) == COMMIT_REJECTED);
  CHECK(core.commitUtcAnchor(host) == COMMIT_OK);
  UtcAnchorPayload sntp = host;
  sntp.anchor_id = 2;
  sntp.source = ANCHOR_SNTP;
  sntp.quality = ANCHOR_SYNCHRONIZED;
  sntp.uncertainty_us = 1000;
  sntp.mono_us = 1200;
  CHECK(core.commitUtcAnchor(sntp) == COMMIT_OK);
  CHECK(core.commitUtcAnchor(host) == COMMIT_REJECTED);
  CHECK(core.end(1300, RUN_END_EXPLICIT, 0) == COMMIT_OK);
  CHECK(core.state() == CORE_DRAINING);
  UtcAnchorPayload late = sntp;
  late.anchor_id = 3;
  late.mono_us = 1300;
  CHECK(core.commitUtcAnchor(late) == COMMIT_CLOSED);

  while (core.journalUsed() != 0) {
    AckDisposition disposition = ACK_NO_IN_FLIGHT;
    CHECK(ackFront(core, ACK_ACCEPTED, ACK_FLAG_ACCEPTED, 0, &disposition));
    CHECK(disposition == ACK_RECLAIMED);
  }
  CHECK(core.state() == CORE_COMPLETE);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_CLOSED);

  FixedJournal auth_journal;
  Core auth(auth_journal);
  CHECK(auth.begin(runId(64), 1000, runBegin()) == COMMIT_OK);
  CHECK(auth.acquireInFlight(NULL) == false);
  auth.enterAuthBlocked();
  CHECK(auth.state() == CORE_AUTH_BLOCKED);
  FrameView blocked;
  CHECK(!auth.acquireInFlight(&blocked));
  return true;
}

static bool sampleAnchorBinding() {
  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.u32_value = 42;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 1;
  sample.field_count = 1;
  sample.fields = &value;

  FixedJournal pre_anchor_journal;
  Core pre_anchor(pre_anchor_journal);
  CHECK(pre_anchor.begin(runId(80), 1000, runBegin()) == COMMIT_OK);
  CHECK(pre_anchor.commitSchema(schema) == COMMIT_OK);
  SampleCommitResult result = pre_anchor.commitSample(1050, sample);
  CHECK(result.status == SAMPLE_ENCODER_REJECTED);
  CHECK(result.sample_seq == 0);
  sample.anchor_id = 0;
  result = pre_anchor.commitSample(1060, sample);
  CHECK(result.status == SAMPLE_COMMITTED);
  CHECK(result.sample_seq == 1);

  FixedJournal anchored_journal;
  Core anchored(anchored_journal);
  CHECK(anchored.begin(runId(96), 1000, runBegin()) == COMMIT_OK);
  CHECK(anchored.commitSchema(schema) == COMMIT_OK);
  CHECK(anchored.pollMicros(1100));
  UtcAnchorPayload first_anchor;
  first_anchor.anchor_id = 1;
  first_anchor.source = ANCHOR_AUTHENTICATED_HOST;
  first_anchor.quality = ANCHOR_APPROXIMATE;
  first_anchor.uncertainty_us = 5000;
  first_anchor.mono_us = 1100;
  first_anchor.utc_ns = UINT64_C(1786400000000000000);
  first_anchor.frequency_error_ppb = INT32_MIN;
  CHECK(anchored.commitUtcAnchor(first_anchor) == COMMIT_OK);
  sample.anchor_id = 0;
  result = anchored.commitSample(1110, sample);
  CHECK(result.status == SAMPLE_ENCODER_REJECTED);
  sample.anchor_id = 1;
  result = anchored.commitSample(1120, sample);
  CHECK(result.status == SAMPLE_COMMITTED);

  CHECK(anchored.pollMicros(1200));
  UtcAnchorPayload second_anchor = first_anchor;
  second_anchor.anchor_id = 2;
  second_anchor.source = ANCHOR_SNTP;
  second_anchor.quality = ANCHOR_SYNCHRONIZED;
  second_anchor.uncertainty_us = 1000;
  second_anchor.mono_us = 1200;
  CHECK(anchored.commitUtcAnchor(second_anchor) == COMMIT_OK);
  while (anchored.journalUsed() != 0) {
    AckDisposition disposition = ACK_NO_IN_FLIGHT;
    CHECK(ackFront(anchored, ACK_ACCEPTED, ACK_FLAG_ACCEPTED, 0,
                   &disposition));
    CHECK(disposition == ACK_RECLAIMED);
  }
  sample.anchor_id = 1;
  result = anchored.commitSample(1210, sample);
  CHECK(result.status == SAMPLE_ENCODER_REJECTED);
  sample.anchor_id = 2;
  result = anchored.commitSample(1220, sample);
  CHECK(result.status == SAMPLE_COMMITTED);
  return true;
}

static bool sequenceAndCounterLimits() {
  uint8_t encoded[256];
  size_t encoded_size = 0;
  FrameContext reserved_context = frameContext();
  reserved_context.frame_seq = UINT32_MAX;
  CHECK(encodeFrame(encoded, sizeof(encoded), GAP, reserved_context, NULL, 0,
                    &encoded_size) == ENCODE_INVALID_FIELD);

  SampleRecordPayload reserved_record;
  memset(&reserved_record, 0, sizeof(reserved_record));
  reserved_record.sample_seq = UINT32_MAX;
  reserved_record.mono_us = 1000;
  SamplesPayload reserved_samples;
  reserved_samples.base_mono_us = 1000;
  reserved_samples.record_count = 1;
  reserved_samples.records = &reserved_record;
  CHECK(encodeSamplesPayload(encoded, sizeof(encoded), reserved_samples,
                             &encoded_size) == ENCODE_INVALID_FIELD);

  FixedJournal frame_journal;
  Core frame_core(frame_journal);
  CHECK(frame_core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CoreTestAccess::setNextFrameSequence(frame_core, UINT32_MAX - 1);
  CHECK(frame_core.commitCapabilities(capabilities()) == COMMIT_OK);
  const size_t caps_slot = CoreTestAccess::findSlot(frame_core, CAPABILITIES);
  CHECK(caps_slot < kJournalSlotCount);
  CHECK(getU32(frame_journal.slot(caps_slot).bytes + 12) == UINT32_MAX - 1);
  CHECK(frame_core.nextFrameSequence() == UINT32_MAX);
  CHECK(frame_core.commitCapabilities(capabilities()) ==
        COMMIT_SEQUENCE_EXHAUSTED);
  CHECK(frame_core.nextFrameSequence() == UINT32_MAX);
  CHECK(frame_core.state() == CORE_FAULTED);
  CHECK(frame_core.commitCapabilities(capabilities()) == COMMIT_FAULTED);

  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.u32_value = 1;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;

  FixedJournal sample_journal;
  Core sample_core(sample_journal);
  CHECK(sample_core.begin(runId(16), 1000, runBegin()) == COMMIT_OK);
  CHECK(sample_core.commitSchema(schema) == COMMIT_OK);
  CoreTestAccess::setNextSampleSequence(sample_core, UINT32_MAX - 1);
  SampleCommitResult result = sample_core.commitSample(1100, sample);
  CHECK(result.status == SAMPLE_COMMITTED);
  CHECK(result.sample_seq == UINT32_MAX - 1);
  CHECK(sample_core.nextSampleSequence() == UINT32_MAX);
  CHECK(sample_core.flushSamples() == COMMIT_OK);
  const size_t maximum_sample_slot =
      CoreTestAccess::findSlot(sample_core, SAMPLES);
  CHECK(maximum_sample_slot < kJournalSlotCount);
  CHECK(getU32(sample_journal.slot(maximum_sample_slot).bytes +
               kFrameHeaderBytes + 16 + 8) == UINT32_MAX - 1);
  result = sample_core.commitSample(1200, sample);
  CHECK(result.status == SAMPLE_SEQUENCE_EXHAUSTED);
  CHECK(result.sample_seq == UINT32_MAX);
  CHECK(sample_core.nextSampleSequence() == UINT32_MAX);
  CHECK(sample_core.state() == CORE_FAULTED);
  CHECK(sample_core.flushSamples() == COMMIT_FAULTED);

  FixedJournal seal_exhausted_journal;
  Core seal_exhausted(seal_exhausted_journal);
  CHECK(seal_exhausted.begin(runId(24), 1000, runBegin()) == COMMIT_OK);
  CHECK(seal_exhausted.commitSchema(schema) == COMMIT_OK);
  for (uint32_t i = 0; i < 28; ++i) {
    CHECK(seal_exhausted.commitSample(1100 + i, sample).status ==
          SAMPLE_COMMITTED);
  }
  CoreTestAccess::setNextFrameSequence(seal_exhausted, UINT32_MAX);
  result = seal_exhausted.commitSample(1200, sample);
  CHECK(result.status == SAMPLE_SEQUENCE_EXHAUSTED);
  CHECK(result.sample_seq == UINT32_MAX);
  CHECK(seal_exhausted.state() == CORE_FAULTED);
  CHECK(seal_exhausted.nextFrameSequence() == UINT32_MAX);
  CHECK(seal_exhausted.nextSampleSequence() == 28);
  CHECK(CoreTestAccess::findSlot(seal_exhausted, SAMPLES) ==
        kJournalSlotCount);

  FixedJournal saturated_journal;
  Core saturated(saturated_journal);
  CHECK(saturated.begin(runId(32), 1000, runBegin()) == COMMIT_OK);
  CHECK(saturated.commitSchema(schema) == COMMIT_OK);
  CHECK(saturated.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(saturated.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(saturated.commitCapabilities(capabilities()) == COMMIT_OK);
  CoreStats near_limit;
  near_limit.attempted_samples = UINT32_MAX - 1;
  near_limit.encoded_samples = UINT32_MAX;
  near_limit.frame.dropped_samples = UINT32_MAX - 1;
  near_limit.frame.dropped_frames = UINT32_MAX;
  near_limit.frame.corrupt_frames = UINT32_MAX;
  near_limit.frame.backpressure_events = UINT32_MAX - 1;
  near_limit.frame.retries = UINT32_MAX;
  CoreTestAccess::setStats(saturated, near_limit);
  result = saturated.commitSample(1100, sample);
  CHECK(result.status == SAMPLE_DROPPED_NEWEST);
  CHECK(saturated.stats().attempted_samples == UINT32_MAX);
  CHECK(saturated.stats().encoded_samples == UINT32_MAX);
  CHECK(saturated.stats().frame.dropped_samples == UINT32_MAX);
  CHECK(saturated.stats().frame.dropped_frames == UINT32_MAX);
  CHECK(saturated.stats().frame.corrupt_frames == UINT32_MAX);
  CHECK(saturated.stats().frame.backpressure_events == UINT32_MAX);
  FrameView front;
  CHECK(saturated.acquireInFlight(&front));
  saturated.noteRetryAttempt();
  CHECK(saturated.stats().frame.retries == UINT32_MAX);
  return true;
}

static bool sampleBatchBoundaries() {
  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;

  FixedJournal count_journal;
  Core count_core(count_journal);
  CHECK(count_core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CHECK(count_core.commitSchema(schema) == COMMIT_OK);
  for (uint32_t i = 0; i < 64; ++i) {
    value.value.u32_value = i;
    const SampleCommitResult result = count_core.commitSample(1000 + i, sample);
    CHECK(result.status == SAMPLE_COMMITTED);
    CHECK(result.sample_seq == i);
  }
  value.value.u32_value = 64;
  CHECK(count_core.commitSample(1064, sample).status == SAMPLE_COMMITTED);
  size_t sealed_records = 0;
  size_t sample_frames = 0;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    const JournalSlot& slot = count_journal.slot(i);
    if (slot.state != JOURNAL_EMPTY && slot.bytes[5] == SAMPLES) {
      ++sample_frames;
      const uint16_t records = getU16(slot.bytes + kFrameHeaderBytes);
      CHECK(records <= kMaxSampleRecords);
      sealed_records += records;
    }
  }
  CHECK(sample_frames == 2);
  CHECK(sealed_records == 56);
  CHECK(count_core.hasBuilder());
  CHECK(count_core.stats().encoded_samples == 65);

  SampleRecordPayload maximum_records[kMaxSampleRecords];
  memset(maximum_records, 0, sizeof(maximum_records));
  for (uint16_t i = 0; i < kMaxSampleRecords; ++i) {
    maximum_records[i].schema_id = 1;
    maximum_records[i].revision = 1;
    maximum_records[i].sample_seq = i;
    maximum_records[i].mono_us = 5000;
  }
  SamplesPayload maximum_payload;
  maximum_payload.base_mono_us = 5000;
  maximum_payload.record_count = kMaxSampleRecords;
  maximum_payload.records = maximum_records;
  uint8_t oversized_payload[16 + kMaxSampleRecords * 20];
  size_t oversized_size = 0;
  CHECK(encodeSamplesPayload(oversized_payload, sizeof(oversized_payload),
                             maximum_payload, &oversized_size) == ENCODE_OK);
  CHECK(oversized_size == sizeof(oversized_payload));
  maximum_payload.record_count = kMaxSampleRecords + 1;
  CHECK(encodeSamplesPayload(oversized_payload, sizeof(oversized_payload),
                             maximum_payload, &oversized_size) ==
        ENCODE_INVALID_ARGUMENT);

  FixedJournal delta_journal;
  Core delta_core(delta_journal);
  CHECK(delta_core.begin(runId(16), 0,
                         runBegin(VOLATILE_BEST_EFFORT, 0)) == COMMIT_OK);
  CHECK(delta_core.commitSchema(schema) == COMMIT_OK);
  value.value.u32_value = 1;
  CHECK(delta_core.commitSample(0, sample).status == SAMPLE_COMMITTED);
  CHECK(delta_core.pollMicros(0x7fffffffu));
  CHECK(delta_core.pollMicros(0xfffffffeu));
  value.value.u32_value = 2;
  CHECK(delta_core.commitSample(0xffffffffu, sample).status ==
        SAMPLE_COMMITTED);
  value.value.u32_value = 3;
  CHECK(delta_core.commitSample(0, sample).status == SAMPLE_COMMITTED);
  const size_t delta_slot = CoreTestAccess::findSlot(delta_core, SAMPLES);
  CHECK(delta_slot < kJournalSlotCount);
  const JournalSlot& delta_frame = delta_journal.slot(delta_slot);
  CHECK(getU16(delta_frame.bytes + kFrameHeaderBytes) == 2);
  const uint16_t first_record_bytes =
      getU16(delta_frame.bytes + kFrameHeaderBytes + 16);
  const size_t second_record =
      kFrameHeaderBytes + 16 + first_record_bytes;
  CHECK(getU32(delta_frame.bytes + second_record + 12) == UINT32_MAX);
  CHECK(delta_core.hasBuilder());
  CHECK(delta_core.monotonicMicros() == UINT64_C(0x100000000));
  return true;
}

static bool blockedEndLatchesAndCompletesExactly() {
  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;

  FixedJournal journal;
  Core core(journal);
  CHECK(core.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CHECK(core.commitSchema(schema) == COMMIT_OK);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_OK);
  CHECK(core.journalUsed() == 4);
  for (uint32_t i = 0; i < 29; ++i) {
    value.value.u32_value = i;
    CHECK(core.commitSample(1100 + i, sample).status == SAMPLE_COMMITTED);
  }
  CHECK(core.journalUsed() == 5);
  CHECK(core.hasBuilder());
  CHECK(core.end(2000, RUN_END_EXPLICIT, 0) == COMMIT_WOULD_BLOCK);
  CHECK(core.state() == CORE_DRAINING);
  CHECK(!CoreTestAccess::endQueued(core));
  CHECK(core.hasBuilder());
  CHECK(core.commitSample(2100, sample).status == SAMPLE_CLOSED);
  CHECK(core.stats().attempted_samples == 29);
  CHECK(core.end(9999, RUN_END_EXPLICIT, 0) == COMMIT_WOULD_BLOCK);
  CHECK(core.end(9999, 2, 0) == COMMIT_REJECTED);
  CHECK(CoreTestAccess::findSlot(core, RUN_END) == kJournalSlotCount);

  AckDisposition disposition = ACK_NO_IN_FLIGHT;
  FrameView retry_frame;
  CHECK(core.acquireInFlight(&retry_frame));
  core.noteRetryAttempt();
  CHECK(ackFront(core, ACK_ACCEPTED, ACK_FLAG_ACCEPTED, 0, &disposition));
  CHECK(disposition == ACK_RECLAIMED);
  CHECK(core.state() == CORE_DRAINING);
  CHECK(core.end(9999, RUN_END_EXPLICIT, 0) == COMMIT_OK);
  CHECK(CoreTestAccess::endQueued(core));
  const uint32_t end_sequence = CoreTestAccess::endSequence(core);
  const size_t end_slot = CoreTestAccess::findSlot(core, RUN_END);
  CHECK(end_slot < kJournalSlotCount);
  const JournalSlot& end_frame = journal.slot(end_slot);
  CHECK(getU32(end_frame.bytes + 12) == end_sequence);
  CHECK(getU64(end_frame.bytes + kFrameHeaderBytes + 4) == 2000);
  CHECK(getU32(end_frame.bytes + kFrameHeaderBytes + 12) == 29);
  CHECK(getU32(end_frame.bytes + kFrameHeaderBytes + 16) == 29);
  CHECK(getU32(end_frame.bytes + kFrameHeaderBytes + 32) == 2);
  CHECK(getU32(end_frame.bytes + kFrameHeaderBytes + 36) == 1);
  CHECK(getU32(end_frame.bytes + 48) == 2);
  CHECK(getU32(end_frame.bytes + 52) == 1);
  CHECK(core.end(12000, RUN_END_EXPLICIT, 0) == COMMIT_OK);
  CHECK(CoreTestAccess::findSlot(core, RUN_END, 1) == kJournalSlotCount);
  CHECK(!core.pollMicros(1000));
  CHECK(core.pendingGapCount() == 0);
  CHECK(core.commitCapabilities(capabilities()) == COMMIT_CLOSED);

  bool end_ack_seen = false;
  while (core.journalUsed() != 0) {
    FrameView frame;
    CHECK(core.acquireInFlight(&frame));
    const bool is_end = frame.frame_seq == end_sequence;
    std::vector<uint8_t> retained_end;
    if (is_end) {
      retained_end.assign(frame.bytes, frame.bytes + frame.size);
    }
    core.noteRetryAttempt();
    if (is_end) {
      FrameView retried_end;
      CHECK(core.acquireInFlight(&retried_end));
      CHECK(retried_end.size == retained_end.size());
      CHECK(memcmp(retried_end.bytes, &retained_end[0], retained_end.size()) ==
            0);
      CHECK(core.stats().frame.retries == 7);
      CHECK(getU32(retried_end.bytes + 52) == 6);
      CHECK(getU32(retried_end.bytes + kFrameHeaderBytes + 36) == 6);
    }
    uint8_t ack[kAckBytes];
    makeAck(ack, core.runId(), frame.frame_seq, frame.crc32c, ACK_ACCEPTED,
            ACK_FLAG_ACCEPTED | (is_end ? ACK_FLAG_RUN_TERMINAL : 0));
    CHECK(core.handleAck(ack, sizeof(ack), NULL) == ACK_RECLAIMED);
    if (is_end) {
      end_ack_seen = true;
    } else {
      CHECK(core.state() == CORE_DRAINING);
    }
  }
  CHECK(end_ack_seen);
  CHECK(core.state() == CORE_COMPLETE);
  return true;
}

static bool corruptionDuringDrainFaults() {
  FixedJournal control_journal;
  Core control(control_journal);
  CHECK(control.begin(runId(), 1000, runBegin()) == COMMIT_OK);
  CHECK(control.end(1100, RUN_END_EXPLICIT, 0) == COMMIT_OK);
  FrameView frame;
  CHECK(control.acquireInFlight(&frame));
  CHECK(frame.bytes[5] == RUN_BEGIN);
  uint8_t* corrupt = const_cast<uint8_t*>(frame.bytes);
  corrupt[kFrameHeaderBytes] ^= 1;
  CHECK(!control.acquireInFlight(&frame));
  CHECK(control.state() == CORE_FAULTED);
  CHECK(control.stats().frame.dropped_frames == 0);
  CHECK(control.pendingGapCount() == 0);

  const SchemaPayload schema = oneFieldSchema(FIELD_U32);
  SampleFieldValue value;
  memset(&value, 0, sizeof(value));
  value.present = 1;
  value.value.u32_value = 1;
  SampleInput sample;
  sample.schema_id = schema.schema_id;
  sample.revision = schema.revision;
  sample.anchor_id = 0;
  sample.field_count = 1;
  sample.fields = &value;
  FixedJournal sample_journal;
  Core sample_core(sample_journal);
  CHECK(sample_core.begin(runId(16), 1000, runBegin()) == COMMIT_OK);
  CHECK(sample_core.commitSchema(schema) == COMMIT_OK);
  CHECK(sample_core.commitSample(1100, sample).status == SAMPLE_COMMITTED);
  CHECK(sample_core.flushSamples() == COMMIT_OK);
  CHECK(sample_core.end(1200, RUN_END_EXPLICIT, 0) == COMMIT_OK);
  CHECK(ackFront(sample_core));
  CHECK(ackFront(sample_core));
  CHECK(sample_core.acquireInFlight(&frame));
  CHECK(frame.bytes[5] == SAMPLES);
  corrupt = const_cast<uint8_t*>(frame.bytes);
  corrupt[kFrameHeaderBytes + 20] ^= 1;
  CHECK(!sample_core.acquireInFlight(&frame));
  CHECK(sample_core.state() == CORE_FAULTED);
  CHECK(sample_core.stats().frame.dropped_frames == 0);
  CHECK(sample_core.pendingGapCount() == 0);
  return true;
}

struct TestCase {
  const char* name;
  bool (*function)();
};

}  // namespace

int main() {
  const TestCase tests[] = {
      {"golden vectors", goldenVectors},
      {"all payload and frame encoders", allPayloadAndFrameEncoders},
      {"bounds, reserved bytes, corruption", boundsReservedAndCorruption},
      {"ACK validation and retry identity", ackValidationAndRetryIdentity},
      {"ACK status precedence", ackStatusPrecedesRetryFlag},
      {"samples, clock, and schema", samplesClockAndSchema},
      {"journal overflow and GAP reserve", journalOverflowAndGapReserve},
      {"capabilities fixed profile", capabilitiesMatchFixedProfile},
      {"pending GAP truth", pendingGapsRemainTruthful},
      {"journal corruption and reset", journalCorruptionAndReset},
      {"anchors, end, and terminal states", anchorsEndAndTerminalStates},
      {"sample anchor binding", sampleAnchorBinding},
      {"sequence and counter limits", sequenceAndCounterLimits},
      {"sample batch boundaries", sampleBatchBoundaries},
      {"blocked END terminal latch", blockedEndLatchesAndCompletesExactly},
      {"drain corruption", corruptionDuringDrainFaults},
  };
  size_t passed = 0;
  for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); ++i) {
    const bool ok = tests[i].function();
    printf("%s %s\n", ok ? "PASS" : "FAIL", tests[i].name);
    if (!ok) {
      return 1;
    }
    ++passed;
  }
  printf("PASS %zu/%zu tests; sizeof(JournalSlot)=%zu, "
         "sizeof(FixedJournal)=%zu, sizeof(Core)=%zu\n",
         passed, sizeof(tests) / sizeof(tests[0]), sizeof(JournalSlot),
         sizeof(FixedJournal), sizeof(Core));
  return 0;
}
