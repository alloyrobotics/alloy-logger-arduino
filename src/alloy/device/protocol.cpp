#include "protocol.h"

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

static bool sameRunId(const RunId& left, const RunId& right) {
  return memcmp(left.bytes, right.bytes, sizeof(left.bytes)) == 0;
}

static bool validFrameType(FrameType type) {
  return type >= RUN_BEGIN && type <= RUN_END;
}

static bool validReliability(ReliabilityTier tier) {
  return tier >= VOLATILE_BEST_EFFORT && tier <= LOSS_INTOLERANT;
}

static bool safeIdentifier(const TextView& text, uint8_t minimum,
                           uint8_t maximum) {
  if (text.size < minimum || text.size > maximum || text.data == NULL) {
    return false;
  }
  for (uint8_t i = 0; i < text.size; ++i) {
    const unsigned char c = static_cast<unsigned char>(text.data[i]);
    const bool ascii_letter = (c >= 'A' && c <= 'Z') ||
                              (c >= 'a' && c <= 'z');
    if (!ascii_letter && !(c >= '0' && c <= '9') && c != '_' && c != '-') {
      return false;
    }
  }
  return true;
}

static bool hasAlloyPrefix(const TextView& text) {
  static const char kPrefix[] = "_alloy_";
  return text.size >= sizeof(kPrefix) - 1 &&
         memcmp(text.data, kPrefix, sizeof(kPrefix) - 1) == 0;
}

static bool sameText(const TextView& left, const TextView& right) {
  return left.size == right.size &&
         (left.size == 0 || memcmp(left.data, right.data, left.size) == 0);
}

static bool validUtf8Text(const TextView& text, uint8_t maximum) {
  if (text.size > maximum || (text.size != 0 && text.data == NULL)) {
    return false;
  }
  size_t i = 0;
  while (i < text.size) {
    const uint8_t first = static_cast<uint8_t>(text.data[i]);
    uint32_t codepoint = 0;
    size_t continuation = 0;
    if (first < 0x80) {
      codepoint = first;
    } else if ((first & 0xe0) == 0xc0) {
      codepoint = first & 0x1f;
      continuation = 1;
      if (codepoint < 2) {
        return false;
      }
    } else if ((first & 0xf0) == 0xe0) {
      codepoint = first & 0x0f;
      continuation = 2;
    } else if ((first & 0xf8) == 0xf0) {
      codepoint = first & 0x07;
      continuation = 3;
    } else {
      return false;
    }
    if (i + continuation >= text.size) {
      return false;
    }
    for (size_t j = 0; j < continuation; ++j) {
      const uint8_t next = static_cast<uint8_t>(text.data[i + 1 + j]);
      if ((next & 0xc0) != 0x80) {
        return false;
      }
      codepoint = (codepoint << 6) | (next & 0x3f);
    }
    if ((continuation == 2 && codepoint < 0x800) ||
        (continuation == 3 && codepoint < 0x10000) ||
        codepoint > 0x10ffff ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      return false;
    }
    if (codepoint <= 0x1f || (codepoint >= 0x7f && codepoint <= 0x9f)) {
      return false;
    }
    i += continuation + 1;
  }
  return true;
}

static bool validPrintableAscii(const TextView& text, uint8_t maximum) {
  if (text.size > maximum || (text.size != 0 && text.data == NULL)) {
    return false;
  }
  for (uint8_t i = 0; i < text.size; ++i) {
    const uint8_t c = static_cast<uint8_t>(text.data[i]);
    if (c < 0x20 || c > 0x7e) {
      return false;
    }
  }
  return true;
}

static uint32_t crcWithZeroRange(const uint8_t* bytes, size_t size,
                                 size_t zero_offset, size_t zero_size) {
  uint32_t crc = 0xffffffffu;
  for (size_t i = 0; i < size; ++i) {
    uint8_t value = bytes[i];
    if (i >= zero_offset && i < zero_offset + zero_size) {
      value = 0;
    }
    crc ^= value;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      const uint32_t mask = 0u - (crc & 1u);
      crc = (crc >> 1) ^ (0x82f63b78u & mask);
    }
  }
  return crc ^ 0xffffffffu;
}

static EncodeStatus finishPayload(size_t used, size_t* encoded_bytes) {
  if (encoded_bytes != NULL) {
    *encoded_bytes = used;
  }
  return ENCODE_OK;
}

static void failSize(size_t* encoded_bytes) {
  if (encoded_bytes != NULL) {
    *encoded_bytes = 0;
  }
}

static bool room(size_t used, size_t needed, size_t capacity) {
  return needed <= capacity && used <= capacity - needed;
}

static EncodeStatus completeTypedFrame(
    uint8_t* output, size_t capacity, FrameType type,
    const FrameContext& context, size_t payload_bytes, size_t* encoded_bytes) {
  if (payload_bytes > capacity - kFrameHeaderBytes) {
    failSize(encoded_bytes);
    return ENCODE_BUFFER_TOO_SMALL;
  }
  return encodeFrame(output, capacity, type, context,
                     output + kFrameHeaderBytes, payload_bytes, encoded_bytes);
}

static bool zeroBytes(const uint8_t* bytes, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    if (bytes[i] != 0) {
      return false;
    }
  }
  return true;
}

static bool validatePayloadReserved(FrameType type, const uint8_t* payload,
                                    size_t size) {
  switch (type) {
    case RUN_BEGIN:
      return size >= 16 && zeroBytes(payload + 5, 3);
    case CAPABILITIES:
      return size >= 32 && zeroBytes(payload + 28, 4);
    case SCHEMA: {
      if (size < 8 || !zeroBytes(payload + 6, 2)) {
        return false;
      }
      const uint8_t channel_len = payload[4];
      const uint8_t fields = payload[5];
      size_t offset = 8 + channel_len;
      for (uint8_t i = 0; i < fields; ++i) {
        if (!room(offset, 6, size) || payload[offset + 2] != 0 ||
            payload[offset + 5] != 0) {
          return false;
        }
        const size_t descriptor = 6u + payload[offset + 3] + payload[offset + 4];
        if (!room(offset, descriptor, size)) {
          return false;
        }
        offset += descriptor;
      }
      return offset == size;
    }
    case UTC_ANCHOR:
      return size == 32 && zeroBytes(payload + 28, 4);
    case SAMPLES: {
      if (size < 16 || !zeroBytes(payload + 2, 2) ||
          getU16(payload + 12) != 20 || !zeroBytes(payload + 14, 2)) {
        return false;
      }
      const uint16_t count = getU16(payload);
      size_t offset = 16;
      for (uint16_t i = 0; i < count; ++i) {
        if (!room(offset, 20, size) || !zeroBytes(payload + offset + 18, 2)) {
          return false;
        }
        const uint16_t record_bytes = getU16(payload + offset);
        if (record_bytes < 20 || !room(offset, record_bytes, size)) {
          return false;
        }
        offset += record_bytes;
      }
      return offset == size;
    }
    case GAP:
      return size == 40 && zeroBytes(payload + 2, 2);
    case RUN_END:
      return size == 40 && payload[1] == 0;
  }
  return false;
}

}  // namespace

uint32_t crc32c(const uint8_t* bytes, size_t size) {
  if (bytes == NULL && size != 0) {
    return 0;
  }
  return crcWithZeroRange(bytes, size, size, 0);
}

uint8_t fieldWidth(FieldType type) {
  switch (type) {
    case FIELD_BOOL:
    case FIELD_I8:
    case FIELD_U8:
      return 1;
    case FIELD_I16:
    case FIELD_U16:
      return 2;
    case FIELD_I32:
    case FIELD_U32:
    case FIELD_F32:
      return 4;
    case FIELD_F64:
      return 8;
  }
  return 0;
}

EncodeStatus encodeRunBeginPayload(uint8_t* output, size_t capacity,
                                   const RunBeginPayload& payload,
                                   size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL || !safeIdentifier(payload.device, 1, 32) ||
      !validUtf8Text(payload.firmware, 32) ||
      !validUtf8Text(payload.mission, 64)) {
    return ENCODE_INVALID_TEXT;
  }
  if (!validReliability(payload.reliability)) {
    return ENCODE_INVALID_ENUM;
  }
  const size_t size = 16u + payload.device.size + payload.firmware.size +
                      payload.mission.size;
  if (size > 144) {
    return ENCODE_FRAME_TOO_LARGE;
  }
  if (capacity < size) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, size);
  output[0] = payload.device.size;
  output[1] = payload.firmware.size;
  output[2] = payload.mission.size;
  output[3] = static_cast<uint8_t>(payload.reliability);
  output[4] = payload.boot_reason;
  putU64(output + 8, payload.mono_start_us);
  size_t offset = 16;
  memcpy(output + offset, payload.device.data, payload.device.size);
  offset += payload.device.size;
  if (payload.firmware.size != 0) {
    memcpy(output + offset, payload.firmware.data, payload.firmware.size);
    offset += payload.firmware.size;
  }
  if (payload.mission.size != 0) {
    memcpy(output + offset, payload.mission.data, payload.mission.size);
  }
  return finishPayload(size, encoded_bytes);
}

EncodeStatus encodeCapabilitiesPayload(uint8_t* output, size_t capacity,
                                      const CapabilitiesPayload& payload,
                                      size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL || !validUtf8Text(payload.board, 32) ||
      !validUtf8Text(payload.core, 24) || !validUtf8Text(payload.radio, 24)) {
    return ENCODE_INVALID_TEXT;
  }
  if (!validReliability(payload.active_reliability) ||
      payload.scheduler_kind < 1 || payload.scheduler_kind > 2 ||
      payload.journal_kind > 3) {
    return ENCODE_INVALID_ENUM;
  }
  if (payload.maximum_frame_bytes < kFrameHeaderBytes ||
      payload.maximum_frame_bytes > kProtocolMaxFrameBytes ||
      payload.journal_slots == 0 ||
      payload.journal_slot_bytes < kFrameHeaderBytes ||
      payload.journal_slot_bytes > payload.maximum_frame_bytes ||
      payload.maximum_schemas == 0 ||
      payload.maximum_fields_per_schema == 0 ||
      payload.maximum_fields_per_schema > kMaxFieldsPerSchema) {
    return ENCODE_INVALID_FIELD;
  }
  const size_t size = 32u + payload.board.size + payload.core.size +
                      payload.radio.size;
  if (capacity < size) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, size);
  putU16(output, payload.board_code);
  putU16(output + 2, payload.adapter_revision);
  putU64(output + 4, payload.capability_bits);
  putU16(output + 12, payload.maximum_frame_bytes);
  putU16(output + 14, payload.journal_slots);
  putU16(output + 16, payload.journal_slot_bytes);
  output[18] = payload.maximum_schemas;
  output[19] = payload.maximum_fields_per_schema;
  output[20] = payload.journal_kind;
  output[21] = static_cast<uint8_t>(payload.active_reliability);
  putU16(output + 22, payload.monotonic_resolution_us);
  output[24] = payload.scheduler_kind;
  output[25] = payload.board.size;
  output[26] = payload.core.size;
  output[27] = payload.radio.size;
  size_t offset = 32;
  if (payload.board.size != 0) {
    memcpy(output + offset, payload.board.data, payload.board.size);
    offset += payload.board.size;
  }
  if (payload.core.size != 0) {
    memcpy(output + offset, payload.core.data, payload.core.size);
    offset += payload.core.size;
  }
  if (payload.radio.size != 0) {
    memcpy(output + offset, payload.radio.data, payload.radio.size);
  }
  return finishPayload(size, encoded_bytes);
}

EncodeStatus encodeSchemaPayload(uint8_t* output, size_t capacity,
                                 const SchemaPayload& payload,
                                 size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL || !safeIdentifier(payload.channel, 1, 24)) {
    return ENCODE_INVALID_TEXT;
  }
  if (payload.field_count > kMaxFieldsPerSchema ||
      (payload.field_count != 0 && payload.fields == NULL)) {
    return ENCODE_INVALID_FIELD;
  }
  size_t size = 8u + payload.channel.size;
  for (uint8_t i = 0; i < payload.field_count; ++i) {
    const FieldDescriptor& field = payload.fields[i];
    if (field.field_id != i || field.flags != 0 || fieldWidth(field.type) == 0) {
      return ENCODE_INVALID_FIELD;
    }
    if (!safeIdentifier(field.name, 1, 24) || hasAlloyPrefix(field.name) ||
        !validPrintableAscii(field.unit, 12)) {
      return ENCODE_INVALID_TEXT;
    }
    for (uint8_t prior = 0; prior < i; ++prior) {
      if (sameText(payload.fields[prior].name, field.name)) {
        return ENCODE_INVALID_FIELD;
      }
    }
    size += 6u + field.name.size + field.unit.size;
  }
  if (size > 704) {
    return ENCODE_FRAME_TOO_LARGE;
  }
  if (capacity < size) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, size);
  putU16(output, payload.schema_id);
  putU16(output + 2, payload.revision);
  output[4] = payload.channel.size;
  output[5] = payload.field_count;
  memcpy(output + 8, payload.channel.data, payload.channel.size);
  size_t offset = 8u + payload.channel.size;
  for (uint8_t i = 0; i < payload.field_count; ++i) {
    const FieldDescriptor& field = payload.fields[i];
    output[offset] = field.field_id;
    output[offset + 1] = static_cast<uint8_t>(field.type);
    output[offset + 2] = 0;
    output[offset + 3] = field.name.size;
    output[offset + 4] = field.unit.size;
    output[offset + 5] = 0;
    offset += 6;
    memcpy(output + offset, field.name.data, field.name.size);
    offset += field.name.size;
    if (field.unit.size != 0) {
      memcpy(output + offset, field.unit.data, field.unit.size);
      offset += field.unit.size;
    }
  }
  return finishPayload(size, encoded_bytes);
}

EncodeStatus encodeUtcAnchorPayload(uint8_t* output, size_t capacity,
                                    const UtcAnchorPayload& payload,
                                    size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL) {
    return ENCODE_INVALID_ARGUMENT;
  }
  if (payload.source < ANCHOR_SNTP || payload.source > ANCHOR_GNSS ||
      payload.quality < ANCHOR_APPROXIMATE ||
      payload.quality > ANCHOR_SYNCHRONIZED || payload.anchor_id == 0 ||
      payload.utc_ns == 0) {
    return ENCODE_INVALID_ENUM;
  }
  if (capacity < 32) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, 32);
  putU16(output, payload.anchor_id);
  output[2] = static_cast<uint8_t>(payload.source);
  output[3] = static_cast<uint8_t>(payload.quality);
  putU32(output + 4, payload.uncertainty_us);
  putU64(output + 8, payload.mono_us);
  putU64(output + 16, payload.utc_ns);
  putU32(output + 24, static_cast<uint32_t>(payload.frequency_error_ppb));
  return finishPayload(32, encoded_bytes);
}

EncodeStatus encodeSamplesPayload(uint8_t* output, size_t capacity,
                                  const SamplesPayload& payload,
                                  size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL || payload.records == NULL || payload.record_count == 0 ||
      payload.record_count > kMaxSampleRecords) {
    return ENCODE_INVALID_ARGUMENT;
  }
  if (capacity < 16) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, 16);
  putU16(output, payload.record_count);
  putU64(output + 4, payload.base_mono_us);
  putU16(output + 12, 20);
  size_t offset = 16;
  uint32_t previous_delta = 0;
  uint32_t previous_sample_seq = 0;
  for (uint16_t record_index = 0; record_index < payload.record_count;
       ++record_index) {
    const SampleRecordPayload& record = payload.records[record_index];
    if (record.sample_seq == UINT32_MAX ||
        record.mono_us < payload.base_mono_us ||
        record.field_count > kMaxFieldsPerSchema ||
        (record.field_count != 0 &&
         (record.field_types == NULL || record.fields == NULL))) {
      return ENCODE_INVALID_FIELD;
    }
    const uint64_t delta64 = record.mono_us - payload.base_mono_us;
    if (delta64 > UINT32_MAX ||
        (record_index == 0 && delta64 != 0) ||
        (record_index != 0 && delta64 < previous_delta) ||
        (record_index != 0 && record.sample_seq <= previous_sample_seq)) {
      return ENCODE_INVALID_FIELD;
    }
    previous_delta = static_cast<uint32_t>(delta64);
    previous_sample_seq = record.sample_seq;
    size_t values_bytes = 0;
    for (uint8_t i = 0; i < record.field_count; ++i) {
      const uint8_t width = fieldWidth(record.field_types[i]);
      if (width == 0) {
        return ENCODE_INVALID_FIELD;
      }
      values_bytes += width;
    }
    const size_t record_bytes = 20u + values_bytes;
    if (record_bytes > UINT16_MAX || !room(offset, record_bytes, capacity)) {
      return ENCODE_BUFFER_TOO_SMALL;
    }
    memset(output + offset, 0, record_bytes);
    putU16(output + offset, static_cast<uint16_t>(record_bytes));
    putU16(output + offset + 2, record.schema_id);
    putU16(output + offset + 4, record.revision);
    putU16(output + offset + 6, record.anchor_id);
    putU32(output + offset + 8, record.sample_seq);
    putU32(output + offset + 12, previous_delta);
    uint16_t present_mask = 0;
    size_t value_offset = offset + 20;
    for (uint8_t i = 0; i < record.field_count; ++i) {
      const FieldType type = record.field_types[i];
      const uint8_t width = fieldWidth(type);
      bool present = record.fields[i].present != 0;
      if (present && type == FIELD_BOOL &&
          record.fields[i].value.boolean_value > 1) {
        return ENCODE_INVALID_FIELD;
      }
      if (present && type == FIELD_F32 &&
          !isfinite(record.fields[i].value.f32_value)) {
        present = false;
      }
      if (present && type == FIELD_F64 &&
          !isfinite(record.fields[i].value.f64_value)) {
        present = false;
      }
      if (present) {
        present_mask = static_cast<uint16_t>(present_mask | (1u << i));
        switch (type) {
          case FIELD_BOOL:
            output[value_offset] = record.fields[i].value.boolean_value;
            break;
          case FIELD_I8:
            output[value_offset] =
                static_cast<uint8_t>(record.fields[i].value.i8_value);
            break;
          case FIELD_U8:
            output[value_offset] = record.fields[i].value.u8_value;
            break;
          case FIELD_I16:
            putU16(output + value_offset,
                   static_cast<uint16_t>(record.fields[i].value.i16_value));
            break;
          case FIELD_U16:
            putU16(output + value_offset, record.fields[i].value.u16_value);
            break;
          case FIELD_I32:
            putU32(output + value_offset,
                   static_cast<uint32_t>(record.fields[i].value.i32_value));
            break;
          case FIELD_U32:
            putU32(output + value_offset, record.fields[i].value.u32_value);
            break;
          case FIELD_F32: {
            uint32_t bits = 0;
            memcpy(&bits, &record.fields[i].value.f32_value, sizeof(bits));
            putU32(output + value_offset, bits);
            break;
          }
          case FIELD_F64: {
            uint64_t bits = 0;
            memcpy(&bits, &record.fields[i].value.f64_value, sizeof(bits));
            putU64(output + value_offset, bits);
            break;
          }
        }
      }
      value_offset += width;
    }
    putU16(output + offset + 16, present_mask);
    offset += record_bytes;
  }
  return finishPayload(offset, encoded_bytes);
}

EncodeStatus encodeGapPayload(uint8_t* output, size_t capacity,
                              const GapPayload& payload,
                              size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL) {
    return ENCODE_INVALID_ARGUMENT;
  }
  if (payload.reason < GAP_JOURNAL_FULL ||
      payload.reason > GAP_END_DRAIN_TIMEOUT ||
      payload.action < GAP_DROP_NEWEST || payload.action > GAP_FAULTED) {
    return ENCODE_INVALID_ENUM;
  }
  if (payload.mono_end_us < payload.mono_start_us) {
    return ENCODE_INVALID_FIELD;
  }
  if (capacity < 40) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, 40);
  output[0] = static_cast<uint8_t>(payload.reason);
  output[1] = static_cast<uint8_t>(payload.action);
  putU32(output + 4, payload.first_lost_sample_seq);
  putU32(output + 8, payload.lost_sample_count);
  putU32(output + 12, payload.first_lost_frame_seq);
  putU32(output + 16, payload.lost_frame_count);
  putU64(output + 20, payload.mono_start_us);
  putU64(output + 28, payload.mono_end_us);
  putU32(output + 36, payload.detail);
  return finishPayload(40, encoded_bytes);
}

EncodeStatus encodeRunEndPayload(uint8_t* output, size_t capacity,
                                 const RunEndPayload& payload,
                                 size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL) {
    return ENCODE_INVALID_ARGUMENT;
  }
  if (payload.reason != RUN_END_EXPLICIT || payload.flags != 0) {
    return ENCODE_INVALID_FIELD;
  }
  if (capacity < 40) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  memset(output, 0, 40);
  output[0] = payload.reason;
  putU16(output + 2, payload.flags);
  putU64(output + 4, payload.mono_end_us);
  putU32(output + 12, payload.attempted_samples);
  putU32(output + 16, payload.encoded_samples);
  putU32(output + 20, payload.dropped_samples);
  putU32(output + 24, payload.dropped_frames);
  putU32(output + 28, payload.corrupt_frames);
  putU32(output + 32, payload.backpressure_events);
  putU32(output + 36, payload.retries);
  return finishPayload(40, encoded_bytes);
}

EncodeStatus encodeFrame(uint8_t* output, size_t capacity, FrameType type,
                         const FrameContext& context, const uint8_t* payload,
                         size_t payload_bytes, size_t* encoded_bytes) {
  failSize(encoded_bytes);
  if (output == NULL || (payload_bytes != 0 && payload == NULL)) {
    return ENCODE_INVALID_ARGUMENT;
  }
  if (!validFrameType(type)) {
    return ENCODE_INVALID_ENUM;
  }
  if (context.frame_seq == UINT32_MAX ||
      zeroBytes(context.run_id.bytes, sizeof(context.run_id.bytes)) ||
      context.journal_slots_used > context.journal_slot_capacity) {
    return ENCODE_INVALID_FIELD;
  }
  if (payload_bytes > UINT16_MAX || payload_bytes + kFrameHeaderBytes >
                                          kProtocolMaxFrameBytes) {
    return ENCODE_FRAME_TOO_LARGE;
  }
  const size_t total = kFrameHeaderBytes + payload_bytes;
  if (capacity < total) {
    return ENCODE_BUFFER_TOO_SMALL;
  }
  if (payload_bytes != 0) {
    memmove(output + kFrameHeaderBytes, payload, payload_bytes);
  }
  memset(output, 0, kFrameHeaderBytes);
  output[0] = 'A';
  output[1] = 'L';
  output[2] = 'Y';
  output[3] = '1';
  output[4] = kWireVersion;
  output[5] = static_cast<uint8_t>(type);
  putU16(output + 8, kFrameHeaderBytes);
  putU16(output + 10, static_cast<uint16_t>(payload_bytes));
  putU32(output + 12, context.frame_seq);
  memcpy(output + 16, context.run_id.bytes, sizeof(context.run_id.bytes));
  putU16(output + 32, context.journal_slots_used);
  putU16(output + 34, context.journal_slot_capacity);
  putU32(output + 36, context.counters.dropped_samples);
  putU32(output + 40, context.counters.dropped_frames);
  putU32(output + 44, context.counters.corrupt_frames);
  putU32(output + 48, context.counters.backpressure_events);
  putU32(output + 52, context.counters.retries);
  const uint32_t crc = crcWithZeroRange(output, total, 60, 4);
  putU32(output + 60, crc);
  return finishPayload(total, encoded_bytes);
}

#define ALLOY_DEFINE_TYPED_FRAME(name, type_name, frame_type, payload_encoder)  \
  EncodeStatus name(uint8_t* output, size_t capacity,                       \
                    const FrameContext& context, const type_name& payload,   \
                    size_t* encoded_bytes) {                                \
    failSize(encoded_bytes);                                                \
    if (output == NULL || capacity < kFrameHeaderBytes) {                    \
      return output == NULL ? ENCODE_INVALID_ARGUMENT                        \
                            : ENCODE_BUFFER_TOO_SMALL;                       \
    }                                                                        \
    size_t payload_bytes = 0;                                                \
    const EncodeStatus status = payload_encoder(                             \
        output + kFrameHeaderBytes, capacity - kFrameHeaderBytes, payload,    \
        &payload_bytes);                                                      \
    if (status != ENCODE_OK) {                                               \
      return status;                                                         \
    }                                                                        \
    return completeTypedFrame(output, capacity, frame_type, context,          \
                              payload_bytes, encoded_bytes);                  \
  }

ALLOY_DEFINE_TYPED_FRAME(encodeRunBeginFrame, RunBeginPayload, RUN_BEGIN,
                         encodeRunBeginPayload)
ALLOY_DEFINE_TYPED_FRAME(encodeCapabilitiesFrame, CapabilitiesPayload,
                         CAPABILITIES, encodeCapabilitiesPayload)
ALLOY_DEFINE_TYPED_FRAME(encodeSchemaFrame, SchemaPayload, SCHEMA,
                         encodeSchemaPayload)
ALLOY_DEFINE_TYPED_FRAME(encodeUtcAnchorFrame, UtcAnchorPayload, UTC_ANCHOR,
                         encodeUtcAnchorPayload)
ALLOY_DEFINE_TYPED_FRAME(encodeSamplesFrame, SamplesPayload, SAMPLES,
                         encodeSamplesPayload)
ALLOY_DEFINE_TYPED_FRAME(encodeGapFrame, GapPayload, GAP, encodeGapPayload)
ALLOY_DEFINE_TYPED_FRAME(encodeRunEndFrame, RunEndPayload, RUN_END,
                         encodeRunEndPayload)

#undef ALLOY_DEFINE_TYPED_FRAME

EncodeStatus inspectFrame(const uint8_t* frame, size_t size, FrameInfo* info) {
  if (frame == NULL || info == NULL) {
    return ENCODE_INVALID_ARGUMENT;
  }
  if (size < kFrameHeaderBytes || size > kProtocolMaxFrameBytes ||
      memcmp(frame, "ALY1", 4) != 0 || frame[4] != kWireVersion ||
      !validFrameType(static_cast<FrameType>(frame[5])) ||
      getU16(frame + 6) != 0 || getU16(frame + 8) != kFrameHeaderBytes ||
      getU16(frame + 10) != size - kFrameHeaderBytes ||
      getU32(frame + 12) == UINT32_MAX ||
      !zeroBytes(frame + 56, 4) || zeroBytes(frame + 16, 16) ||
      getU16(frame + 32) > getU16(frame + 34)) {
    return ENCODE_INVALID_FIELD;
  }
  const FrameType type = static_cast<FrameType>(frame[5]);
  if (!validatePayloadReserved(type, frame + kFrameHeaderBytes,
                               size - kFrameHeaderBytes)) {
    return ENCODE_INVALID_FIELD;
  }
  const uint32_t expected_crc = getU32(frame + 60);
  if (crcWithZeroRange(frame, size, 60, 4) != expected_crc) {
    return ENCODE_INVALID_FIELD;
  }
  info->type = type;
  info->payload_bytes = getU16(frame + 10);
  info->frame_seq = getU32(frame + 12);
  memcpy(info->run_id.bytes, frame + 16, sizeof(info->run_id.bytes));
  info->journal_slots_used = getU16(frame + 32);
  info->journal_slot_capacity = getU16(frame + 34);
  info->counters.dropped_samples = getU32(frame + 36);
  info->counters.dropped_frames = getU32(frame + 40);
  info->counters.corrupt_frames = getU32(frame + 44);
  info->counters.backpressure_events = getU32(frame + 48);
  info->counters.retries = getU32(frame + 52);
  info->crc32c = expected_crc;
  return ENCODE_OK;
}

AckValidation decodeAndValidateAck(const uint8_t* bytes, size_t size,
                                   const RunId& expected_run_id,
                                   uint32_t expected_frame_seq,
                                   uint32_t expected_request_crc, Ack* ack) {
  if (bytes == NULL || ack == NULL) {
    return ACK_INVALID_ARGUMENT;
  }
  if (size != kAckBytes) {
    return ACK_INVALID_SIZE;
  }
  if (memcmp(bytes, "ALYA", 4) != 0) {
    return ACK_INVALID_MAGIC;
  }
  if (bytes[4] != kWireVersion) {
    return ACK_INVALID_VERSION;
  }
  const uint16_t flags = getU16(bytes + 6);
  if (bytes[5] > ACK_PROTOCOL_FORMAT_CONFLICT || (flags & ~0x000fu) != 0 ||
      getU16(bytes + 8) != kAckBytes) {
    return ACK_INVALID_FLAGS;
  }
  const uint32_t ack_crc = getU32(bytes + 40);
  if (crcWithZeroRange(bytes, size, 40, 4) != ack_crc) {
    return ACK_INVALID_CRC;
  }
  Ack parsed;
  parsed.status = static_cast<AckStatus>(bytes[5]);
  parsed.flags = flags;
  parsed.detail = getU16(bytes + 10);
  parsed.frame_seq = getU32(bytes + 12);
  parsed.lowest_unresolved_seq = getU32(bytes + 16);
  parsed.retry_after_ms = getU32(bytes + 20);
  memcpy(parsed.run_id.bytes, bytes + 24, sizeof(parsed.run_id.bytes));
  parsed.crc32c = ack_crc;
  parsed.request_frame_crc = getU32(bytes + 44);
  *ack = parsed;
  if (!sameRunId(parsed.run_id, expected_run_id)) {
    return ACK_WRONG_RUN;
  }
  if (parsed.frame_seq != expected_frame_seq) {
    return ACK_WRONG_SEQUENCE;
  }
  if (parsed.request_frame_crc != expected_request_crc) {
    return ACK_WRONG_REQUEST_CRC;
  }
  return ACK_VALID;
}

}  // namespace v1
}  // namespace device
}  // namespace alloy
