#ifndef ALLOY_DEVICE_CORE_H_
#define ALLOY_DEVICE_CORE_H_

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

namespace alloy {
namespace device {
namespace v1 {

static const size_t kJournalSlotCount = 6;
static const size_t kJournalSlotBytes = 768;
static const uint8_t kCoreMaxSchemas = 8;
static const uint8_t kPendingGapCapacity = 2;
static const uint32_t kMaximumMicrosPollIntervalUs = 0x7fffffffu;

#ifdef ALLOY_DEVICE_TESTING
struct CoreTestAccess;
#endif

enum JournalSlotState {
  JOURNAL_EMPTY = 0,
  JOURNAL_COMMITTED = 1,
  JOURNAL_IN_FLIGHT = 2
};

struct JournalSlot {
  uint16_t len;
  uint8_t state;
  uint8_t reserved;
  uint32_t ordinal;
  uint8_t bytes[kJournalSlotBytes];
};

class FixedJournal {
 public:
  FixedJournal();
  void clear();
  size_t used() const;
  const JournalSlot& slot(size_t index) const;

 private:
  JournalSlot slots_[kJournalSlotCount];
  friend class Core;
#ifdef ALLOY_DEVICE_TESTING
  friend struct CoreTestAccess;
#endif
};

class MicrosExtender {
 public:
  MicrosExtender();
  void reset(uint32_t raw_micros);
  bool update(uint32_t raw_micros, uint64_t* extended_micros);
  bool initialized() const;
  uint64_t value() const;

 private:
  bool initialized_;
  uint32_t previous_raw_;
  uint64_t extended_;
};

enum CoreState {
  CORE_IDLE = 0,
  CORE_CAPTURING,
  CORE_DRAINING,
  CORE_COMPLETE,
  CORE_AUTH_BLOCKED,
  CORE_STALE,
  CORE_FAULTED
};

enum CommitStatus {
  COMMIT_OK = 0,
  COMMIT_DROPPED,
  COMMIT_WOULD_BLOCK,
  COMMIT_REJECTED,
  COMMIT_BUSY,
  COMMIT_CLOSED,
  COMMIT_FAULTED,
  COMMIT_SEQUENCE_EXHAUSTED
};

enum SampleCommitStatus {
  SAMPLE_COMMITTED = 0,
  SAMPLE_DROPPED_NEWEST,
  SAMPLE_WOULD_BLOCK,
  SAMPLE_ENCODER_REJECTED,
  SAMPLE_CLOCK_REGRESSION,
  SAMPLE_UNKNOWN_SCHEMA,
  SAMPLE_CLOSED,
  SAMPLE_FAULTED,
  SAMPLE_SEQUENCE_EXHAUSTED
};

struct SampleCommitResult {
  SampleCommitStatus status;
  uint32_t sample_seq;
};

struct SampleInput {
  uint16_t schema_id;
  uint16_t revision;
  uint16_t anchor_id;
  uint8_t field_count;
  const SampleFieldValue* fields;
};

struct FrameView {
  const uint8_t* bytes;
  uint16_t size;
  uint32_t frame_seq;
  uint32_t crc32c;
};

enum AckDisposition {
  ACK_RECLAIMED = 0,
  ACK_RETAINED_RETRY,
  ACK_REJECTED_MALFORMED,
  ACK_ENTERED_AUTH_BLOCKED,
  ACK_ENTERED_STALE,
  ACK_ENTERED_FAULT,
  ACK_NO_IN_FLIGHT
};

struct CoreStats {
  uint32_t attempted_samples;
  uint32_t encoded_samples;
  FrameCounters frame;
};

struct PendingGap {
  bool pending;
  GapPayload payload;
};

class Core {
 public:
  explicit Core(FixedJournal& journal);

  void reset();
  CommitStatus begin(const RunId& run_id, uint32_t raw_micros,
                     const RunBeginPayload& payload);
  CommitStatus commitCapabilities(const CapabilitiesPayload& payload);
  CommitStatus commitSchema(const SchemaPayload& payload);
  CommitStatus commitUtcAnchor(const UtcAnchorPayload& payload);
  SampleCommitResult commitSample(uint32_t raw_micros,
                                  const SampleInput& sample);
  CommitStatus flushSamples();
  CommitStatus end(uint32_t raw_micros, uint8_t reason, uint16_t flags);

  bool pollMicros(uint32_t raw_micros);
  CommitStatus flushPendingGap();

  bool acquireInFlight(FrameView* frame);
  void noteRetryAttempt();
  void enterAuthBlocked();
  AckDisposition handleAck(const uint8_t* ack_bytes, size_t ack_size,
                           Ack* decoded_ack);

  CoreState state() const;
  const RunId& runId() const;
  uint32_t nextFrameSequence() const;
  uint32_t nextSampleSequence() const;
  uint64_t monotonicMicros() const;
  const CoreStats& stats() const;
  const PendingGap& pendingGap() const;
  uint8_t pendingGapCount() const;
  size_t journalUsed() const;
  bool hasBuilder() const;
  bool hasInFlight() const;

 private:
  struct SchemaEntry {
    bool used;
    uint16_t schema_id;
    uint16_t revision;
    uint8_t field_count;
    uint8_t field_types[kMaxFieldsPerSchema];
  };

  FixedJournal& journal_;
  CoreState state_;
  RunId run_id_;
  ReliabilityTier reliability_;
  MicrosExtender clock_;
  CoreStats stats_;
  PendingGap pending_gaps_[kPendingGapCapacity];
  uint8_t pending_gap_count_;
  uint32_t next_frame_seq_;
  uint32_t next_sample_seq_;
  uint32_t next_ordinal_;
  uint16_t last_anchor_id_;
  int8_t in_flight_slot_;
  bool builder_active_;
  uint16_t builder_record_count_;
  uint32_t builder_first_sample_seq_;
  bool builder_sample_sequences_contiguous_;
  uint64_t builder_base_mono_us_;
  uint64_t builder_last_mono_us_;
  size_t builder_size_;
  uint8_t builder_[kJournalSlotBytes];
  SchemaEntry schemas_[kCoreMaxSchemas];
  bool slot_metadata_valid_[kJournalSlotCount];
  uint8_t slot_frame_types_[kJournalSlotCount];
  uint32_t slot_frame_sequences_[kJournalSlotCount];
  uint32_t slot_first_sample_sequences_[kJournalSlotCount];
  uint16_t slot_sample_counts_[kJournalSlotCount];
  uint64_t slot_sample_mono_starts_[kJournalSlotCount];
  uint64_t slot_sample_mono_ends_[kJournalSlotCount];
  bool end_latched_;
  bool end_frame_queued_;
  bool end_frame_acked_;
  uint8_t end_reason_;
  uint16_t end_flags_;
  uint64_t end_mono_us_;
  CoreStats end_stats_;
  uint32_t end_frame_seq_;

  Core(const Core&);
  Core& operator=(const Core&);
#ifdef ALLOY_DEVICE_TESTING
  friend struct CoreTestAccess;
#endif

  const SchemaEntry* findSchema(uint16_t schema_id, uint16_t revision) const;
  CommitStatus commitEncodedFrame(FrameType type, const uint8_t* payload,
                                  size_t payload_size, bool control_frame,
                                  int8_t* committed_slot = NULL);
  CommitStatus sealBuilder();
  CommitStatus progressEnd();
  bool recordSampleLoss(GapReason reason, GapAction action,
                        uint32_t sample_seq, uint64_t mono_us,
                        uint32_t detail);
  bool recordFrameLoss(GapReason reason, GapAction action,
                       uint32_t frame_seq, uint64_t mono_us,
                       uint32_t detail);
  size_t trustedJournalUsed() const;
  bool enqueueGap(const GapPayload& gap);
  void clearJournalSlot(size_t index);
  bool handleCorruptJournalSlot(size_t index);
  bool validateJournalSlot(size_t index);
};

static_assert(sizeof(JournalSlot) == 776,
              "Alloy v1 RAM journal slots must be exactly 776 bytes");

}  // namespace v1
}  // namespace device
}  // namespace alloy

#endif  // ALLOY_DEVICE_CORE_H_
