#include "core.h"

#include <math.h>
#include <string.h>

namespace alloy {
namespace device {
namespace v1 {
namespace {

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

static void putU64(uint8_t* output, uint64_t value) {
  putU32(output, static_cast<uint32_t>(value));
  putU32(output + 4, static_cast<uint32_t>(value >> 32));
}

static uint32_t getU32(const uint8_t* input) {
  return static_cast<uint32_t>(input[0]) |
         (static_cast<uint32_t>(input[1]) << 8) |
         (static_cast<uint32_t>(input[2]) << 16) |
         (static_cast<uint32_t>(input[3]) << 24);
}

static uint32_t saturatingAdd(uint32_t value, uint32_t amount) {
  return amount > UINT32_MAX - value ? UINT32_MAX : value + amount;
}

static uint32_t saturatingIncrement(uint32_t value) {
  return value == UINT32_MAX ? UINT32_MAX : value + 1;
}

static bool allZero(const uint8_t* bytes, size_t size) {
  for (size_t i = 0; i < size; ++i) {
    if (bytes[i] != 0) {
      return false;
    }
  }
  return true;
}

static bool contiguousRange(uint32_t first, uint32_t count,
                            uint32_t next_first) {
  return first != UINT32_MAX && next_first != UINT32_MAX &&
         count <= UINT32_MAX - first && first + count == next_first;
}

static bool sameGapIdentity(const GapPayload& left, const GapPayload& right) {
  return left.reason == right.reason && left.action == right.action &&
         left.detail == right.detail;
}

static SampleCommitResult sampleResult(SampleCommitStatus status,
                                       uint32_t sequence) {
  SampleCommitResult result;
  result.status = status;
  result.sample_seq = sequence;
  return result;
}

}  // namespace

FixedJournal::FixedJournal() { clear(); }

void FixedJournal::clear() { memset(slots_, 0, sizeof(slots_)); }

size_t FixedJournal::used() const {
  size_t count = 0;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    if (slots_[i].state != JOURNAL_EMPTY) {
      ++count;
    }
  }
  return count;
}

const JournalSlot& FixedJournal::slot(size_t index) const {
  return slots_[index < kJournalSlotCount ? index : 0];
}

MicrosExtender::MicrosExtender()
    : initialized_(false), previous_raw_(0), extended_(0) {}

void MicrosExtender::reset(uint32_t raw_micros) {
  initialized_ = true;
  previous_raw_ = raw_micros;
  extended_ = raw_micros;
}

bool MicrosExtender::update(uint32_t raw_micros, uint64_t* extended_micros) {
  if (!initialized_) {
    reset(raw_micros);
  } else {
    const uint32_t delta = raw_micros - previous_raw_;
    // A normal wrap has a small unsigned delta. A small backward clock jump has
    // a delta near UINT32_MAX and is rejected without changing clock state.
    if (delta > kMaximumMicrosPollIntervalUs) {
      return false;
    }
    previous_raw_ = raw_micros;
    extended_ += delta;
  }
  if (extended_micros != NULL) {
    *extended_micros = extended_;
  }
  return true;
}

bool MicrosExtender::initialized() const { return initialized_; }

uint64_t MicrosExtender::value() const { return extended_; }

Core::Core(FixedJournal& journal) : journal_(journal) { reset(); }

void Core::reset() {
  journal_.clear();
  state_ = CORE_IDLE;
  memset(&run_id_, 0, sizeof(run_id_));
  reliability_ = VOLATILE_BEST_EFFORT;
  clock_ = MicrosExtender();
  memset(&stats_, 0, sizeof(stats_));
  memset(pending_gaps_, 0, sizeof(pending_gaps_));
  for (uint8_t i = 0; i < kPendingGapCapacity; ++i) {
    pending_gaps_[i].payload.first_lost_sample_seq = UINT32_MAX;
    pending_gaps_[i].payload.first_lost_frame_seq = UINT32_MAX;
  }
  pending_gap_count_ = 0;
  next_frame_seq_ = 0;
  next_sample_seq_ = 0;
  next_ordinal_ = 0;
  last_anchor_id_ = 0;
  in_flight_slot_ = -1;
  builder_active_ = false;
  builder_record_count_ = 0;
  builder_first_sample_seq_ = UINT32_MAX;
  builder_sample_sequences_contiguous_ = false;
  builder_base_mono_us_ = 0;
  builder_last_mono_us_ = 0;
  builder_size_ = 0;
  memset(builder_, 0, sizeof(builder_));
  memset(schemas_, 0, sizeof(schemas_));
  memset(slot_metadata_valid_, 0, sizeof(slot_metadata_valid_));
  memset(slot_frame_types_, 0, sizeof(slot_frame_types_));
  memset(slot_frame_sequences_, 0, sizeof(slot_frame_sequences_));
  memset(slot_first_sample_sequences_, 0xff,
         sizeof(slot_first_sample_sequences_));
  memset(slot_sample_counts_, 0, sizeof(slot_sample_counts_));
  memset(slot_sample_mono_starts_, 0, sizeof(slot_sample_mono_starts_));
  memset(slot_sample_mono_ends_, 0, sizeof(slot_sample_mono_ends_));
  end_latched_ = false;
  end_frame_queued_ = false;
  end_frame_acked_ = false;
  end_reason_ = 0;
  end_flags_ = 0;
  end_mono_us_ = 0;
  memset(&end_stats_, 0, sizeof(end_stats_));
  end_frame_seq_ = UINT32_MAX;
}

CommitStatus Core::begin(const RunId& run_id, uint32_t raw_micros,
                         const RunBeginPayload& payload) {
  if (state_ != CORE_IDLE || journal_.used() != 0) {
    return COMMIT_BUSY;
  }
  if (allZero(run_id.bytes, sizeof(run_id.bytes)) ||
      payload.mono_start_us != static_cast<uint64_t>(raw_micros) ||
      payload.reliability == RECOVERABLE) {
    return COMMIT_REJECTED;
  }
  run_id_ = run_id;
  reliability_ = payload.reliability;
  clock_.reset(raw_micros);
  size_t payload_size = 0;
  const EncodeStatus encoded = encodeRunBeginPayload(
      builder_, sizeof(builder_), payload, &payload_size);
  if (encoded != ENCODE_OK) {
    memset(&run_id_, 0, sizeof(run_id_));
    clock_ = MicrosExtender();
    return COMMIT_REJECTED;
  }
  const CommitStatus committed =
      commitEncodedFrame(RUN_BEGIN, builder_, payload_size, true);
  if (committed == COMMIT_OK) {
    state_ = CORE_CAPTURING;
  } else {
    memset(&run_id_, 0, sizeof(run_id_));
    clock_ = MicrosExtender();
  }
  return committed;
}

CommitStatus Core::commitCapabilities(const CapabilitiesPayload& payload) {
  if (state_ != CORE_CAPTURING) {
    return state_ == CORE_FAULTED ? COMMIT_FAULTED : COMMIT_CLOSED;
  }
  if (payload.active_reliability != reliability_ ||
      payload.active_reliability == RECOVERABLE ||
      payload.maximum_frame_bytes != kUnoFrameBytes ||
      payload.journal_slots != kJournalSlotCount ||
      payload.journal_slot_bytes != kJournalSlotBytes ||
      payload.maximum_schemas != kCoreMaxSchemas ||
      payload.maximum_fields_per_schema != kMaxFieldsPerSchema ||
      payload.journal_kind != JOURNAL_RAM ||
      (payload.capability_bits & CAPABILITY_PERSISTENT_JOURNAL) != 0 ||
      (reliability_ == LOSS_INTOLERANT &&
       (payload.capability_bits & CAPABILITY_BACKPRESSURE) == 0)) {
    return COMMIT_REJECTED;
  }
  const CommitStatus flushed = flushSamples();
  if (flushed != COMMIT_OK) {
    return flushed;
  }
  size_t payload_size = 0;
  if (encodeCapabilitiesPayload(builder_, sizeof(builder_), payload,
                                &payload_size) != ENCODE_OK) {
    return COMMIT_REJECTED;
  }
  return commitEncodedFrame(CAPABILITIES, builder_, payload_size, true);
}

CommitStatus Core::commitSchema(const SchemaPayload& payload) {
  if (state_ != CORE_CAPTURING) {
    return state_ == CORE_FAULTED ? COMMIT_FAULTED : COMMIT_CLOSED;
  }
  if (findSchema(payload.schema_id, payload.revision) != NULL) {
    return COMMIT_REJECTED;
  }
  size_t free_schema = kCoreMaxSchemas;
  for (size_t i = 0; i < kCoreMaxSchemas; ++i) {
    if (!schemas_[i].used) {
      free_schema = i;
      break;
    }
  }
  if (free_schema == kCoreMaxSchemas) {
    return COMMIT_REJECTED;
  }
  const CommitStatus flushed = flushSamples();
  if (flushed != COMMIT_OK) {
    return flushed;
  }
  size_t payload_size = 0;
  if (encodeSchemaPayload(builder_, sizeof(builder_), payload, &payload_size) !=
      ENCODE_OK) {
    return COMMIT_REJECTED;
  }
  const CommitStatus committed =
      commitEncodedFrame(SCHEMA, builder_, payload_size, true);
  if (committed == COMMIT_OK) {
    SchemaEntry& entry = schemas_[free_schema];
    entry.used = true;
    entry.schema_id = payload.schema_id;
    entry.revision = payload.revision;
    entry.field_count = payload.field_count;
    for (uint8_t i = 0; i < payload.field_count; ++i) {
      entry.field_types[i] = payload.fields[i].type;
    }
  }
  return committed;
}

CommitStatus Core::commitUtcAnchor(const UtcAnchorPayload& payload) {
  if (state_ != CORE_CAPTURING) {
    return state_ == CORE_FAULTED ? COMMIT_FAULTED : COMMIT_CLOSED;
  }
  if (payload.anchor_id == 0 || payload.anchor_id <= last_anchor_id_ ||
      payload.utc_ns == 0 ||
      payload.mono_us > clock_.value()) {
    return COMMIT_REJECTED;
  }
  const CommitStatus flushed = flushSamples();
  if (flushed != COMMIT_OK) {
    return flushed;
  }
  size_t payload_size = 0;
  if (encodeUtcAnchorPayload(builder_, sizeof(builder_), payload,
                             &payload_size) != ENCODE_OK) {
    return COMMIT_REJECTED;
  }
  const CommitStatus committed =
      commitEncodedFrame(UTC_ANCHOR, builder_, payload_size, true);
  if (committed == COMMIT_OK) {
    last_anchor_id_ = payload.anchor_id;
  }
  return committed;
}

SampleCommitResult Core::commitSample(uint32_t raw_micros,
                                      const SampleInput& sample) {
  if (state_ != CORE_CAPTURING) {
    return sampleResult(state_ == CORE_FAULTED ? SAMPLE_FAULTED : SAMPLE_CLOSED,
                        UINT32_MAX);
  }
  stats_.attempted_samples = saturatingIncrement(stats_.attempted_samples);

  uint64_t mono_us = 0;
  if (!clock_.update(raw_micros, &mono_us)) {
    if (next_sample_seq_ == UINT32_MAX) {
      state_ = CORE_FAULTED;
      return sampleResult(SAMPLE_SEQUENCE_EXHAUSTED, UINT32_MAX);
    }
    const uint32_t dropped_sequence = next_sample_seq_++;
    if (!recordSampleLoss(GAP_CLOCK_REGRESSION, GAP_DROP_NEWEST,
                          dropped_sequence, clock_.value(), raw_micros)) {
      return sampleResult(SAMPLE_FAULTED, dropped_sequence);
    }
    return sampleResult(SAMPLE_CLOCK_REGRESSION, dropped_sequence);
  }
  if (next_sample_seq_ == UINT32_MAX) {
    state_ = CORE_FAULTED;
    return sampleResult(SAMPLE_SEQUENCE_EXHAUSTED, UINT32_MAX);
  }

  if (trustedJournalUsed() >= kJournalSlotCount - 1) {
    stats_.frame.backpressure_events =
        saturatingIncrement(stats_.frame.backpressure_events);
    if (reliability_ != VOLATILE_BEST_EFFORT) {
      return sampleResult(SAMPLE_WOULD_BLOCK, UINT32_MAX);
    }
    const uint32_t dropped_sequence = next_sample_seq_++;
    if (!recordSampleLoss(GAP_JOURNAL_FULL, GAP_DROP_NEWEST,
                          dropped_sequence, mono_us, 0)) {
      return sampleResult(SAMPLE_FAULTED, dropped_sequence);
    }
    return sampleResult(SAMPLE_DROPPED_NEWEST, dropped_sequence);
  }

  const SchemaEntry* schema = findSchema(sample.schema_id, sample.revision);
  if (schema == NULL) {
    const uint32_t dropped_sequence = next_sample_seq_++;
    if (!recordSampleLoss(GAP_ENCODER_REJECTION, GAP_DROP_NEWEST,
                          dropped_sequence, mono_us, 1)) {
      return sampleResult(SAMPLE_FAULTED, dropped_sequence);
    }
    return sampleResult(SAMPLE_UNKNOWN_SCHEMA, dropped_sequence);
  }
  if (sample.field_count != schema->field_count ||
      (sample.field_count != 0 && sample.fields == NULL)) {
    const uint32_t dropped_sequence = next_sample_seq_++;
    if (!recordSampleLoss(GAP_ENCODER_REJECTION, GAP_DROP_NEWEST,
                          dropped_sequence, mono_us, 2)) {
      return sampleResult(SAMPLE_FAULTED, dropped_sequence);
    }
    return sampleResult(SAMPLE_ENCODER_REJECTED, dropped_sequence);
  }
  const uint16_t expected_anchor_id = last_anchor_id_ == 0 ? 0 : last_anchor_id_;
  if (sample.anchor_id != expected_anchor_id) {
    const uint32_t dropped_sequence = next_sample_seq_++;
    if (!recordSampleLoss(GAP_ENCODER_REJECTION, GAP_DROP_NEWEST,
                          dropped_sequence, mono_us, 4)) {
      return sampleResult(SAMPLE_FAULTED, dropped_sequence);
    }
    return sampleResult(SAMPLE_ENCODER_REJECTED, dropped_sequence);
  }

  size_t value_bytes = 0;
  for (uint8_t i = 0; i < schema->field_count; ++i) {
    const FieldType type = static_cast<FieldType>(schema->field_types[i]);
    value_bytes += fieldWidth(type);
    if (sample.fields[i].present && type == FIELD_BOOL &&
        sample.fields[i].value.boolean_value > 1) {
      const uint32_t dropped_sequence = next_sample_seq_++;
      if (!recordSampleLoss(GAP_ENCODER_REJECTION, GAP_DROP_NEWEST,
                            dropped_sequence, mono_us, 3)) {
        return sampleResult(SAMPLE_FAULTED, dropped_sequence);
      }
      return sampleResult(SAMPLE_ENCODER_REJECTED, dropped_sequence);
    }
  }
  const size_t record_bytes = 20u + value_bytes;
  const bool delta_overflow =
      builder_active_ && mono_us - builder_base_mono_us_ > UINT32_MAX;
  if (builder_active_ &&
      (builder_record_count_ == kMaxSampleRecords ||
       builder_size_ + record_bytes > kJournalSlotBytes - kFrameHeaderBytes ||
       delta_overflow)) {
    const CommitStatus sealed = sealBuilder();
    if (sealed == COMMIT_WOULD_BLOCK) {
      return sampleResult(SAMPLE_WOULD_BLOCK, UINT32_MAX);
    }
    if (sealed != COMMIT_OK && sealed != COMMIT_DROPPED) {
      const SampleCommitStatus status =
          sealed == COMMIT_SEQUENCE_EXHAUSTED
              ? SAMPLE_SEQUENCE_EXHAUSTED
              : (sealed == COMMIT_FAULTED ? SAMPLE_FAULTED
                                          : SAMPLE_ENCODER_REJECTED);
      return sampleResult(status, UINT32_MAX);
    }
  }

  const uint32_t sample_sequence = next_sample_seq_++;
  if (!builder_active_) {
    memset(builder_, 0, 16);
    builder_active_ = true;
    builder_record_count_ = 0;
    builder_first_sample_seq_ = sample_sequence;
    builder_sample_sequences_contiguous_ = true;
    builder_base_mono_us_ = mono_us;
    builder_last_mono_us_ = mono_us;
    builder_size_ = 16;
    putU64(builder_ + 4, builder_base_mono_us_);
    putU16(builder_ + 12, 20);
  } else if (!contiguousRange(builder_first_sample_seq_,
                              builder_record_count_, sample_sequence)) {
    builder_sample_sequences_contiguous_ = false;
  }

  uint8_t* record = builder_ + builder_size_;
  memset(record, 0, record_bytes);
  putU16(record, static_cast<uint16_t>(record_bytes));
  putU16(record + 2, sample.schema_id);
  putU16(record + 4, sample.revision);
  putU16(record + 6, sample.anchor_id);
  putU32(record + 8, sample_sequence);
  putU32(record + 12,
         static_cast<uint32_t>(mono_us - builder_base_mono_us_));
  uint16_t present_mask = 0;
  size_t value_offset = 20;
  for (uint8_t i = 0; i < schema->field_count; ++i) {
    const FieldType type = static_cast<FieldType>(schema->field_types[i]);
    const uint8_t width = fieldWidth(type);
    bool present = sample.fields[i].present != 0;
    if (present && type == FIELD_F32 &&
        !isfinite(sample.fields[i].value.f32_value)) {
      present = false;
    }
    if (present && type == FIELD_F64 &&
        !isfinite(sample.fields[i].value.f64_value)) {
      present = false;
    }
    if (present) {
      present_mask = static_cast<uint16_t>(present_mask | (1u << i));
      switch (type) {
        case FIELD_BOOL:
          record[value_offset] = sample.fields[i].value.boolean_value;
          break;
        case FIELD_I8:
          record[value_offset] =
              static_cast<uint8_t>(sample.fields[i].value.i8_value);
          break;
        case FIELD_U8:
          record[value_offset] = sample.fields[i].value.u8_value;
          break;
        case FIELD_I16:
          putU16(record + value_offset,
                 static_cast<uint16_t>(sample.fields[i].value.i16_value));
          break;
        case FIELD_U16:
          putU16(record + value_offset, sample.fields[i].value.u16_value);
          break;
        case FIELD_I32:
          putU32(record + value_offset,
                 static_cast<uint32_t>(sample.fields[i].value.i32_value));
          break;
        case FIELD_U32:
          putU32(record + value_offset, sample.fields[i].value.u32_value);
          break;
        case FIELD_F32: {
          uint32_t bits = 0;
          memcpy(&bits, &sample.fields[i].value.f32_value, sizeof(bits));
          putU32(record + value_offset, bits);
          break;
        }
        case FIELD_F64: {
          uint64_t bits = 0;
          memcpy(&bits, &sample.fields[i].value.f64_value, sizeof(bits));
          putU64(record + value_offset, bits);
          break;
        }
      }
    }
    value_offset += width;
  }
  putU16(record + 16, present_mask);
  ++builder_record_count_;
  putU16(builder_, builder_record_count_);
  builder_size_ += record_bytes;
  builder_last_mono_us_ = mono_us;
  stats_.encoded_samples = saturatingIncrement(stats_.encoded_samples);
  return sampleResult(SAMPLE_COMMITTED, sample_sequence);
}

CommitStatus Core::flushSamples() {
  if (state_ != CORE_CAPTURING && state_ != CORE_DRAINING) {
    return state_ == CORE_FAULTED ? COMMIT_FAULTED : COMMIT_CLOSED;
  }
  if (!builder_active_) {
    return COMMIT_OK;
  }
  return sealBuilder();
}

CommitStatus Core::end(uint32_t raw_micros, uint8_t reason, uint16_t flags) {
  if (end_latched_ && state_ == CORE_DRAINING) {
    if (reason != end_reason_ || flags != end_flags_) {
      return COMMIT_REJECTED;
    }
    return progressEnd();
  }
  if (state_ != CORE_CAPTURING) {
    return state_ == CORE_FAULTED ? COMMIT_FAULTED : COMMIT_CLOSED;
  }
  if (reason != RUN_END_EXPLICIT || flags != 0) {
    return COMMIT_REJECTED;
  }
  uint64_t mono_us = 0;
  if (!clock_.update(raw_micros, &mono_us)) {
    GapPayload gap;
    memset(&gap, 0, sizeof(gap));
    gap.reason = GAP_CLOCK_REGRESSION;
    gap.action = GAP_DROP_NEWEST;
    gap.first_lost_sample_seq = UINT32_MAX;
    gap.first_lost_frame_seq = UINT32_MAX;
    gap.mono_start_us = clock_.value();
    gap.mono_end_us = clock_.value();
    gap.detail = raw_micros;
    if (!enqueueGap(gap)) {
      return COMMIT_FAULTED;
    }
    return COMMIT_REJECTED;
  }
  end_latched_ = true;
  end_reason_ = reason;
  end_flags_ = flags;
  end_mono_us_ = mono_us;
  end_stats_ = stats_;
  state_ = CORE_DRAINING;
  return progressEnd();
}

CommitStatus Core::progressEnd() {
  if (!end_latched_ || state_ != CORE_DRAINING) {
    return state_ == CORE_FAULTED ? COMMIT_FAULTED : COMMIT_CLOSED;
  }
  if (end_frame_queued_) {
    return COMMIT_OK;
  }
  const CommitStatus samples = flushSamples();
  if (samples != COMMIT_OK) {
    return samples;
  }
  while (pending_gap_count_ != 0) {
    const CommitStatus gap = flushPendingGap();
    if (gap != COMMIT_OK) {
      return gap;
    }
  }
  end_stats_ = stats_;
  RunEndPayload payload;
  payload.reason = end_reason_;
  payload.flags = end_flags_;
  payload.mono_end_us = end_mono_us_;
  payload.attempted_samples = end_stats_.attempted_samples;
  payload.encoded_samples = end_stats_.encoded_samples;
  payload.dropped_samples = end_stats_.frame.dropped_samples;
  payload.dropped_frames = end_stats_.frame.dropped_frames;
  payload.corrupt_frames = end_stats_.frame.corrupt_frames;
  payload.backpressure_events = end_stats_.frame.backpressure_events;
  payload.retries = end_stats_.frame.retries;
  size_t payload_size = 0;
  if (encodeRunEndPayload(builder_, sizeof(builder_), payload, &payload_size) !=
      ENCODE_OK) {
    state_ = CORE_FAULTED;
    return COMMIT_FAULTED;
  }
  int8_t committed_slot = -1;
  const CommitStatus committed =
      commitEncodedFrame(RUN_END, builder_, payload_size, true,
                         &committed_slot);
  if (committed == COMMIT_OK) {
    end_frame_queued_ = true;
    end_frame_seq_ = slot_frame_sequences_[committed_slot];
  }
  return committed;
}

bool Core::pollMicros(uint32_t raw_micros) {
  uint64_t ignored = 0;
  if (state_ == CORE_DRAINING) {
    return clock_.update(raw_micros, &ignored);
  }
  if (state_ != CORE_CAPTURING) {
    return false;
  }
  if (clock_.update(raw_micros, &ignored)) {
    return true;
  }
  GapPayload gap;
  memset(&gap, 0, sizeof(gap));
  gap.reason = GAP_CLOCK_REGRESSION;
  gap.action = GAP_DROP_NEWEST;
  gap.first_lost_sample_seq = UINT32_MAX;
  gap.first_lost_frame_seq = UINT32_MAX;
  gap.mono_start_us = clock_.value();
  gap.mono_end_us = clock_.value();
  gap.detail = raw_micros;
  enqueueGap(gap);
  return false;
}

CommitStatus Core::flushPendingGap() {
  if (pending_gap_count_ == 0) {
    return COMMIT_OK;
  }
  if (state_ != CORE_CAPTURING && state_ != CORE_DRAINING) {
    return COMMIT_CLOSED;
  }
  if (end_frame_queued_) {
    state_ = CORE_FAULTED;
    return COMMIT_FAULTED;
  }
  const CommitStatus samples = flushSamples();
  if (samples != COMMIT_OK) {
    return samples;
  }
  size_t payload_size = 0;
  if (encodeGapPayload(builder_, sizeof(builder_), pending_gaps_[0].payload,
                       &payload_size) != ENCODE_OK) {
    state_ = CORE_FAULTED;
    return COMMIT_FAULTED;
  }
  const CommitStatus committed =
      commitEncodedFrame(GAP, builder_, payload_size, true);
  if (committed == COMMIT_OK) {
    for (uint8_t i = 1; i < pending_gap_count_; ++i) {
      pending_gaps_[i - 1] = pending_gaps_[i];
    }
    --pending_gap_count_;
    PendingGap& cleared = pending_gaps_[pending_gap_count_];
    memset(&cleared, 0, sizeof(cleared));
    cleared.payload.first_lost_sample_seq = UINT32_MAX;
    cleared.payload.first_lost_frame_seq = UINT32_MAX;
  }
  return committed;
}

bool Core::acquireInFlight(FrameView* frame) {
  if (frame == NULL || state_ == CORE_IDLE || state_ == CORE_COMPLETE ||
      state_ == CORE_AUTH_BLOCKED || state_ == CORE_STALE ||
      state_ == CORE_FAULTED) {
    return false;
  }
  for (;;) {
    if (in_flight_slot_ >= 0) {
      if (!validateJournalSlot(static_cast<size_t>(in_flight_slot_))) {
        in_flight_slot_ = -1;
        if (state_ == CORE_FAULTED) {
          return false;
        }
        continue;
      }
      const JournalSlot& slot =
          journal_.slots_[static_cast<size_t>(in_flight_slot_)];
      frame->bytes = slot.bytes;
      frame->size = slot.len;
      frame->frame_seq =
          slot_frame_sequences_[static_cast<size_t>(in_flight_slot_)];
      frame->crc32c = getU32(slot.bytes + 60);
      return true;
    }
    size_t selected = kJournalSlotCount;
    uint32_t selected_sequence = UINT32_MAX;
    bool discarded_corrupt = false;
    for (size_t i = 0; i < kJournalSlotCount; ++i) {
      JournalSlot& slot = journal_.slots_[i];
      if ((slot_metadata_valid_[i] || slot.state != JOURNAL_EMPTY) &&
          !validateJournalSlot(i)) {
        discarded_corrupt = true;
        break;
      }
      if ((slot.state == JOURNAL_COMMITTED ||
           slot.state == JOURNAL_IN_FLIGHT) &&
          (!slot_metadata_valid_[i] || selected == kJournalSlotCount ||
           slot_frame_sequences_[i] < selected_sequence)) {
        selected = i;
        selected_sequence =
            slot_metadata_valid_[i] ? slot_frame_sequences_[i] : 0;
      }
    }
    if (discarded_corrupt) {
      if (state_ == CORE_FAULTED) {
        return false;
      }
      continue;
    }
    if (selected == kJournalSlotCount) {
      return false;
    }
    if (!validateJournalSlot(selected)) {
      if (state_ == CORE_FAULTED) {
        return false;
      }
      continue;
    }
    // RUN_END may be queued behind retained predecessors to preserve the
    // cooperative end() contract. Seal its cumulative counters only when it
    // reaches the front, before its first transmission; every retry after
    // that point remains byte-identical.
    if (slot_frame_types_[selected] == RUN_END &&
        journal_.slots_[selected].state == JOURNAL_COMMITTED &&
        !refreshEndFrame(selected)) {
      state_ = CORE_FAULTED;
      return false;
    }
    journal_.slots_[selected].state = JOURNAL_IN_FLIGHT;
    in_flight_slot_ = static_cast<int8_t>(selected);
  }
}

void Core::noteRetryAttempt() {
  if (in_flight_slot_ >= 0) {
    stats_.frame.retries = saturatingIncrement(stats_.frame.retries);
  }
}

void Core::enterAuthBlocked() {
  if (state_ == CORE_CAPTURING || state_ == CORE_DRAINING) {
    state_ = CORE_AUTH_BLOCKED;
  }
}

AckDisposition Core::handleAck(const uint8_t* ack_bytes, size_t ack_size,
                               Ack* decoded_ack) {
  if (in_flight_slot_ < 0) {
    return ACK_NO_IN_FLIGHT;
  }
  const size_t slot_index = static_cast<size_t>(in_flight_slot_);
  if (!validateJournalSlot(slot_index)) {
    return state_ == CORE_FAULTED ? ACK_ENTERED_FAULT : ACK_NO_IN_FLIGHT;
  }
  JournalSlot& slot = journal_.slots_[slot_index];
  const uint32_t expected_sequence = slot_frame_sequences_[slot_index];
  const uint32_t expected_crc = getU32(slot.bytes + 60);
  Ack local_ack;
  Ack* target = decoded_ack == NULL ? &local_ack : decoded_ack;
  if (decodeAndValidateAck(ack_bytes, ack_size, run_id_, expected_sequence,
                           expected_crc, target) != ACK_VALID) {
    return ACK_REJECTED_MALFORMED;
  }

  const bool accepted =
      target->status == ACK_ACCEPTED &&
      (target->flags & ACK_FLAG_ACCEPTED) != 0 &&
      (target->flags & ACK_FLAG_DUPLICATE) == 0;
  const bool duplicate =
      target->status == ACK_DUPLICATE &&
      (target->flags & ACK_FLAG_DUPLICATE) != 0 &&
      (target->flags & ACK_FLAG_ACCEPTED) != 0;
  if (accepted || duplicate) {
    const FrameType acknowledged_type =
        static_cast<FrameType>(slot_frame_types_[slot_index]);
    const uint32_t acknowledged_sequence = slot_frame_sequences_[slot_index];
    clearJournalSlot(slot_index);
    in_flight_slot_ = -1;
    if (acknowledged_type == RUN_END) {
      if (!end_frame_queued_ || acknowledged_sequence != end_frame_seq_) {
        state_ = CORE_FAULTED;
        return ACK_ENTERED_FAULT;
      }
      end_frame_acked_ = true;
    }
    if (end_frame_acked_ && trustedJournalUsed() == 0 && !builder_active_ &&
        pending_gap_count_ == 0) {
      state_ = CORE_COMPLETE;
    }
    return ACK_RECLAIMED;
  }
  if (target->status == ACK_AUTHENTICATION_FAILURE) {
    state_ = CORE_AUTH_BLOCKED;
    return ACK_ENTERED_AUTH_BLOCKED;
  }
  if (target->status == ACK_RUN_FINALIZED) {
    state_ = CORE_STALE;
    return ACK_ENTERED_STALE;
  }
  switch (target->status) {
    case ACK_BAD_MAGIC:
    case ACK_BAD_VERSION:
    case ACK_BAD_LENGTH:
    case ACK_BAD_CRC:
    case ACK_RUN_NOT_STARTED:
    case ACK_SEQUENCE_CONFLICT:
    case ACK_UNKNOWN_SCHEMA:
    case ACK_SCHEMA_CONFLICT:
    case ACK_INVALID_SAMPLE:
    case ACK_IDENTITY_CONFLICT:
    case ACK_PROTOCOL_FORMAT_CONFLICT:
      state_ = CORE_FAULTED;
      return ACK_ENTERED_FAULT;
    case ACK_RATE_LIMITED:
    case ACK_BUSY:
    case ACK_INTERNAL_ERROR:
      return ACK_RETAINED_RETRY;
    case ACK_ACCEPTED:
    case ACK_DUPLICATE:
    case ACK_RUN_FINALIZED:
    case ACK_AUTHENTICATION_FAILURE:
      break;
  }
  state_ = CORE_FAULTED;
  return ACK_ENTERED_FAULT;
}

CoreState Core::state() const { return state_; }

const RunId& Core::runId() const { return run_id_; }

uint32_t Core::nextFrameSequence() const { return next_frame_seq_; }

uint32_t Core::nextSampleSequence() const { return next_sample_seq_; }

uint64_t Core::monotonicMicros() const { return clock_.value(); }

const CoreStats& Core::stats() const { return stats_; }

const PendingGap& Core::pendingGap() const { return pending_gaps_[0]; }

uint8_t Core::pendingGapCount() const { return pending_gap_count_; }

size_t Core::journalUsed() const { return trustedJournalUsed(); }

bool Core::hasBuilder() const { return builder_active_; }

bool Core::hasInFlight() const { return in_flight_slot_ >= 0; }

bool Core::refreshEndFrame(size_t index) {
  if (index >= kJournalSlotCount || !slot_metadata_valid_[index] ||
      slot_frame_types_[index] != RUN_END || !end_frame_queued_ ||
      slot_frame_sequences_[index] != end_frame_seq_) {
    return false;
  }
  end_stats_ = stats_;
  RunEndPayload payload;
  payload.reason = end_reason_;
  payload.flags = end_flags_;
  payload.mono_end_us = end_mono_us_;
  payload.attempted_samples = end_stats_.attempted_samples;
  payload.encoded_samples = end_stats_.encoded_samples;
  payload.dropped_samples = end_stats_.frame.dropped_samples;
  payload.dropped_frames = end_stats_.frame.dropped_frames;
  payload.corrupt_frames = end_stats_.frame.corrupt_frames;
  payload.backpressure_events = end_stats_.frame.backpressure_events;
  payload.retries = end_stats_.frame.retries;
  uint8_t encoded_payload[40];
  size_t payload_size = 0;
  if (encodeRunEndPayload(encoded_payload, sizeof(encoded_payload), payload,
                          &payload_size) != ENCODE_OK) {
    return false;
  }
  FrameContext context;
  context.frame_seq = end_frame_seq_;
  context.run_id = run_id_;
  context.journal_slots_used =
      static_cast<uint16_t>(trustedJournalUsed());
  context.journal_slot_capacity = kJournalSlotCount;
  context.counters = end_stats_.frame;
  JournalSlot& slot = journal_.slots_[index];
  size_t encoded_bytes = 0;
  if (encodeFrame(slot.bytes, sizeof(slot.bytes), RUN_END, context,
                  encoded_payload, payload_size, &encoded_bytes) != ENCODE_OK ||
      encoded_bytes > UINT16_MAX) {
    return false;
  }
  slot.len = static_cast<uint16_t>(encoded_bytes);
  return true;
}

const Core::SchemaEntry* Core::findSchema(uint16_t schema_id,
                                          uint16_t revision) const {
  for (size_t i = 0; i < kCoreMaxSchemas; ++i) {
    if (schemas_[i].used && schemas_[i].schema_id == schema_id &&
        schemas_[i].revision == revision) {
      return &schemas_[i];
    }
  }
  return NULL;
}

CommitStatus Core::commitEncodedFrame(FrameType type, const uint8_t* payload,
                                      size_t payload_size,
                                      bool control_frame,
                                      int8_t* committed_slot) {
  if (committed_slot != NULL) {
    *committed_slot = -1;
  }
  if (state_ == CORE_FAULTED) {
    return COMMIT_FAULTED;
  }
  if (end_frame_queued_) {
    return COMMIT_CLOSED;
  }
  size_t empty_slot = kJournalSlotCount;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    if (!slot_metadata_valid_[i] &&
        journal_.slots_[i].state == JOURNAL_EMPTY &&
        empty_slot == kJournalSlotCount) {
      empty_slot = i;
    }
  }
  const bool sample_capacity_exhausted =
      !control_frame && trustedJournalUsed() >= kJournalSlotCount - 1;
  if (empty_slot == kJournalSlotCount || sample_capacity_exhausted) {
    stats_.frame.backpressure_events =
        saturatingIncrement(stats_.frame.backpressure_events);
    if (state_ == CORE_DRAINING) {
      return COMMIT_WOULD_BLOCK;
    }
    if (control_frame || reliability_ != VOLATILE_BEST_EFFORT) {
      return COMMIT_WOULD_BLOCK;
    }
    if (next_frame_seq_ == UINT32_MAX) {
      state_ = CORE_FAULTED;
      return COMMIT_SEQUENCE_EXHAUSTED;
    }
    const uint32_t dropped_sequence = next_frame_seq_++;
    next_ordinal_ = saturatingIncrement(next_ordinal_);
    if (!recordFrameLoss(GAP_JOURNAL_FULL, GAP_DROP_NEWEST,
                         dropped_sequence, clock_.value(), 0)) {
      return COMMIT_FAULTED;
    }
    return COMMIT_DROPPED;
  }
  if (next_frame_seq_ == UINT32_MAX) {
    state_ = CORE_FAULTED;
    return COMMIT_SEQUENCE_EXHAUSTED;
  }
  FrameContext context;
  context.frame_seq = next_frame_seq_;
  context.run_id = run_id_;
  context.journal_slots_used =
      static_cast<uint16_t>(trustedJournalUsed() + 1);
  context.journal_slot_capacity = kJournalSlotCount;
  context.counters = type == RUN_END ? end_stats_.frame : stats_.frame;
  JournalSlot& slot = journal_.slots_[empty_slot];
  size_t encoded_bytes = 0;
  const EncodeStatus encoded =
      encodeFrame(slot.bytes, sizeof(slot.bytes), type, context, payload,
                  payload_size, &encoded_bytes);
  if (encoded != ENCODE_OK || encoded_bytes > UINT16_MAX) {
    memset(&slot, 0, sizeof(slot));
    return COMMIT_REJECTED;
  }
  slot.len = static_cast<uint16_t>(encoded_bytes);
  slot.state = JOURNAL_COMMITTED;
  slot.reserved = 0;
  slot.ordinal = next_ordinal_;
  slot_metadata_valid_[empty_slot] = true;
  slot_frame_types_[empty_slot] = static_cast<uint8_t>(type);
  slot_frame_sequences_[empty_slot] = next_frame_seq_;
  slot_first_sample_sequences_[empty_slot] = UINT32_MAX;
  slot_sample_counts_[empty_slot] = 0;
  slot_sample_mono_starts_[empty_slot] = 0;
  slot_sample_mono_ends_[empty_slot] = 0;
  if (committed_slot != NULL) {
    *committed_slot = static_cast<int8_t>(empty_slot);
  }
  ++next_frame_seq_;
  ++next_ordinal_;
  return COMMIT_OK;
}

CommitStatus Core::sealBuilder() {
  if (!builder_active_) {
    return COMMIT_OK;
  }
  const uint16_t record_count = builder_record_count_;
  const uint32_t first_sample = builder_sample_sequences_contiguous_
                                    ? builder_first_sample_seq_
                                    : UINT32_MAX;
  const uint64_t first_mono = builder_base_mono_us_;
  const uint64_t last_mono = builder_last_mono_us_;
  int8_t committed_slot = -1;
  const CommitStatus committed =
      commitEncodedFrame(SAMPLES, builder_, builder_size_, false,
                         &committed_slot);
  if (committed == COMMIT_OK) {
    const size_t index = static_cast<size_t>(committed_slot);
    slot_first_sample_sequences_[index] = first_sample;
    slot_sample_counts_[index] = record_count;
    slot_sample_mono_starts_[index] = first_mono;
    slot_sample_mono_ends_[index] = last_mono;
  }
  if (committed == COMMIT_OK || committed == COMMIT_DROPPED) {
    builder_active_ = false;
    builder_record_count_ = 0;
    builder_first_sample_seq_ = UINT32_MAX;
    builder_sample_sequences_contiguous_ = false;
    builder_base_mono_us_ = 0;
    builder_last_mono_us_ = 0;
    builder_size_ = 0;
  }
  if (committed == COMMIT_DROPPED) {
    stats_.frame.dropped_samples =
        saturatingAdd(stats_.frame.dropped_samples, record_count);
    GapPayload gap;
    memset(&gap, 0, sizeof(gap));
    gap.reason = GAP_JOURNAL_FULL;
    gap.action = GAP_DROP_NEWEST;
    gap.first_lost_sample_seq = first_sample;
    gap.lost_sample_count = record_count;
    gap.first_lost_frame_seq = UINT32_MAX;
    gap.mono_start_us = first_mono;
    gap.mono_end_us = last_mono;
    if (!enqueueGap(gap)) {
      return COMMIT_FAULTED;
    }
  }
  return committed;
}

bool Core::recordSampleLoss(GapReason reason, GapAction action,
                            uint32_t sample_seq, uint64_t mono_us,
                            uint32_t detail) {
  stats_.frame.dropped_samples =
      saturatingIncrement(stats_.frame.dropped_samples);
  GapPayload gap;
  memset(&gap, 0, sizeof(gap));
  gap.reason = reason;
  gap.action = action;
  gap.first_lost_sample_seq = sample_seq;
  gap.lost_sample_count = 1;
  gap.first_lost_frame_seq = UINT32_MAX;
  gap.mono_start_us = mono_us;
  gap.mono_end_us = mono_us;
  gap.detail = detail;
  return enqueueGap(gap);
}

bool Core::recordFrameLoss(GapReason reason, GapAction action,
                           uint32_t frame_seq, uint64_t mono_us,
                           uint32_t detail) {
  stats_.frame.dropped_frames =
      saturatingIncrement(stats_.frame.dropped_frames);
  GapPayload gap;
  memset(&gap, 0, sizeof(gap));
  gap.reason = reason;
  gap.action = action;
  gap.first_lost_sample_seq = UINT32_MAX;
  gap.first_lost_frame_seq = frame_seq;
  gap.lost_frame_count = 1;
  gap.mono_start_us = mono_us;
  gap.mono_end_us = mono_us;
  gap.detail = detail;
  return enqueueGap(gap);
}

size_t Core::trustedJournalUsed() const {
  size_t used = 0;
  for (size_t i = 0; i < kJournalSlotCount; ++i) {
    if (slot_metadata_valid_[i]) {
      ++used;
    }
  }
  return used;
}

bool Core::enqueueGap(const GapPayload& gap) {
  if (end_frame_queued_) {
    state_ = CORE_FAULTED;
    return false;
  }
  if (pending_gap_count_ == 0 ||
      !sameGapIdentity(pending_gaps_[pending_gap_count_ - 1].payload, gap)) {
    if (pending_gap_count_ == kPendingGapCapacity) {
      state_ = CORE_FAULTED;
      return false;
    }
    PendingGap& pending = pending_gaps_[pending_gap_count_++];
    pending.pending = true;
    pending.payload = gap;
    return true;
  }
  GapPayload& current = pending_gaps_[pending_gap_count_ - 1].payload;
  if (gap.lost_sample_count != 0) {
    if (current.lost_sample_count == 0) {
      current.first_lost_sample_seq = gap.first_lost_sample_seq;
    } else if (!contiguousRange(current.first_lost_sample_seq,
                                current.lost_sample_count,
                                gap.first_lost_sample_seq)) {
      current.first_lost_sample_seq = UINT32_MAX;
    }
    current.lost_sample_count =
        saturatingAdd(current.lost_sample_count, gap.lost_sample_count);
  }
  if (gap.lost_frame_count != 0) {
    if (current.lost_frame_count == 0) {
      current.first_lost_frame_seq = gap.first_lost_frame_seq;
    } else if (!contiguousRange(current.first_lost_frame_seq,
                                current.lost_frame_count,
                                gap.first_lost_frame_seq)) {
      current.first_lost_frame_seq = UINT32_MAX;
    }
    current.lost_frame_count =
        saturatingAdd(current.lost_frame_count, gap.lost_frame_count);
  }
  if (gap.mono_start_us < current.mono_start_us) {
    current.mono_start_us = gap.mono_start_us;
  }
  if (gap.mono_end_us > current.mono_end_us) {
    current.mono_end_us = gap.mono_end_us;
  }
  return true;
}

void Core::clearJournalSlot(size_t index) {
  memset(&journal_.slots_[index], 0, sizeof(journal_.slots_[index]));
  slot_metadata_valid_[index] = false;
  slot_frame_types_[index] = 0;
  slot_frame_sequences_[index] = 0;
  slot_first_sample_sequences_[index] = UINT32_MAX;
  slot_sample_counts_[index] = 0;
  slot_sample_mono_starts_[index] = 0;
  slot_sample_mono_ends_[index] = 0;
}

bool Core::handleCorruptJournalSlot(size_t index) {
  stats_.frame.corrupt_frames =
      saturatingIncrement(stats_.frame.corrupt_frames);
  if (in_flight_slot_ == static_cast<int8_t>(index)) {
    in_flight_slot_ = -1;
  }
  const bool trusted_samples =
      slot_metadata_valid_[index] &&
      slot_frame_types_[index] == static_cast<uint8_t>(SAMPLES) &&
      slot_sample_counts_[index] != 0;
  const bool may_discard = reliability_ == VOLATILE_BEST_EFFORT &&
                           state_ == CORE_CAPTURING && !end_latched_ &&
                           trusted_samples;
  if (!may_discard) {
    state_ = CORE_FAULTED;
    return false;
  }

  GapPayload gap;
  memset(&gap, 0, sizeof(gap));
  gap.reason = GAP_JOURNAL_CRC_FAILURE;
  gap.action = GAP_DROP_NEWEST;
  gap.first_lost_sample_seq = slot_first_sample_sequences_[index];
  gap.lost_sample_count = slot_sample_counts_[index];
  gap.first_lost_frame_seq = slot_frame_sequences_[index];
  gap.lost_frame_count = 1;
  gap.mono_start_us = slot_sample_mono_starts_[index];
  gap.mono_end_us = slot_sample_mono_ends_[index];
  gap.detail = 0;
  stats_.frame.dropped_samples = saturatingAdd(
      stats_.frame.dropped_samples, slot_sample_counts_[index]);
  stats_.frame.dropped_frames =
      saturatingIncrement(stats_.frame.dropped_frames);
  clearJournalSlot(index);
  enqueueGap(gap);
  return false;
}

bool Core::validateJournalSlot(size_t index) {
  JournalSlot& slot = journal_.slots_[index];
  FrameInfo info;
  if (slot_metadata_valid_[index] &&
      (slot.state == JOURNAL_COMMITTED || slot.state == JOURNAL_IN_FLIGHT) &&
      slot.reserved == 0 && slot.len <= kJournalSlotBytes &&
      inspectFrame(slot.bytes, slot.len, &info) == ENCODE_OK &&
      info.type == static_cast<FrameType>(slot_frame_types_[index]) &&
      info.frame_seq == slot_frame_sequences_[index]) {
    return true;
  }
  return handleCorruptJournalSlot(index);
}

}  // namespace v1
}  // namespace device
}  // namespace alloy
