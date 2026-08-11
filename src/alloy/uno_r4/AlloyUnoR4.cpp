#if defined(ARDUINO_UNOR4_WIFI)

#include "../../AlloyUnoR4.h"
#include "UnoR4Platform.h"

#include <limits.h>
#include <string.h>

namespace alloy {
namespace uno_r4 {

namespace {

static const uint32_t kMaximumHttpHeaderBytes = 4096;
static const uint32_t kSampleFlushLatencyMs = 250;
static const uint32_t kRssiIntervalMs = 10000;
static const uint32_t kSntpRetryMs = 15000;
static const uint32_t kSntpRefreshMs = 60ul * 60ul * 1000ul;
static const uint32_t kMaximumBackoffMs = 30000;

static bool asciiEqualIgnoreCase(const char* left, size_t left_size,
                                 const char* right) {
  const size_t right_size = strlen(right);
  if (left_size != right_size) return false;
  for (size_t index = 0; index < left_size; ++index) {
    char a = left[index];
    char b = right[index];
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
}

static bool parseUnsigned64(const char* text, size_t size, uint64_t* value) {
  if (size == 0 || value == nullptr) return false;
  uint64_t parsed = 0;
  for (size_t index = 0; index < size; ++index) {
    const char character = text[index];
    if (character < '0' || character > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(character - '0');
    if (parsed > (UINT64_MAX - digit) / 10u) return false;
    parsed = parsed * 10u + digit;
  }
  *value = parsed;
  return true;
}

static bool isZeroAddress(const IPAddress& address) {
  return address == IPAddress(0, 0, 0, 0);
}

static CommitResult mapCommitStatus(device::v1::CommitStatus status) {
  switch (status) {
    case device::v1::COMMIT_OK:
      return CommitResult::Accepted;
    case device::v1::COMMIT_DROPPED:
    case device::v1::COMMIT_WOULD_BLOCK:
    case device::v1::COMMIT_BUSY:
      return CommitResult::WouldBlock;
    case device::v1::COMMIT_REJECTED:
    case device::v1::COMMIT_CLOSED:
      return CommitResult::Invalid;
    case device::v1::COMMIT_FAULTED:
    case device::v1::COMMIT_SEQUENCE_EXHAUSTED:
      return CommitResult::Faulted;
  }
  return CommitResult::Faulted;
}

static const uint32_t kLedConnecting[3] = {
    0x00006060, 0x06060000, 0x00000606,
};
static const uint32_t kLedOnline[3] = {
    0x00000001, 0x03060c18, 0x30600000,
};
static const uint32_t kLedUploading[3] = {
    0x000060f0, 0x61e66c60, 0x60000000,
};
static const uint32_t kLedBuffering[3] = {
    0x00000000, 0x7fe7fe7f, 0xe0000000,
};
static const uint32_t kLedComplete[3] = {
    0x00000003, 0x060c1830, 0x60000000,
};
static const uint32_t kLedError[3] = {
    0x06060000, 0x00606000, 0x00060600,
};

}  // namespace

Config::Config()
    : ssid(nullptr),
      password(nullptr),
      api_key(nullptr),
      device_id(nullptr),
      mesh_path(nullptr),
      firmware(""),
      mission(""),
      host("ingest.alloylogger.com"),
      ca_cert(nullptr),
      request_path("/v2/frame"),
      port(443),
      finalize_after_ms(0),
      wifi_connect_timeout_ms(8000),
      dhcp_timeout_ms(15000),
      tls_connect_timeout_ms(8000),
      response_timeout_ms(15000),
      diagnostics(nullptr),
      use_led_matrix(true) {}

Sample::Sample(Logger* logger, uint16_t schema_id, uint16_t revision,
               uint16_t anchor_id, uint32_t raw_micros,
               uint8_t field_count,
               const uint8_t* field_types)
    : logger_(logger),
      schema_id_(schema_id),
      revision_(revision),
      anchor_id_(anchor_id),
      raw_micros_(raw_micros),
      field_count_(field_count),
      invalid_(logger == nullptr || field_types == nullptr || field_count == 0 ||
               field_count > device::v1::kMaxFieldsPerSchema),
      committed_(false) {
  memset(field_types_, 0, sizeof(field_types_));
  memset(fields_, 0, sizeof(fields_));
  if (!invalid_) {
    memcpy(field_types_, field_types, field_count * sizeof(field_types_[0]));
  }
}

Sample::Sample(Sample&& other)
    : logger_(other.logger_),
      schema_id_(other.schema_id_),
      revision_(other.revision_),
      anchor_id_(other.anchor_id_),
      raw_micros_(other.raw_micros_),
      field_count_(other.field_count_),
      invalid_(other.invalid_),
      committed_(other.committed_) {
  memcpy(field_types_, other.field_types_, sizeof(field_types_));
  memcpy(fields_, other.fields_, sizeof(fields_));
  other.logger_ = nullptr;
  other.invalid_ = true;
  other.committed_ = true;
}

Sample::~Sample() {}

Sample& Sample::setValue(uint8_t field_id, device::v1::FieldType type,
                         const device::v1::SampleValue& value) {
  if (committed_ || invalid_ || field_id >= field_count_ ||
      field_types_[field_id] != static_cast<uint8_t>(type)) {
    invalid_ = true;
    return *this;
  }
  fields_[field_id].present = 1;
  fields_[field_id].value = value;
  return *this;
}

Sample& Sample::setBool(uint8_t field_id, bool value) {
  device::v1::SampleValue encoded = {};
  encoded.boolean_value = value ? 1 : 0;
  return setValue(field_id, device::v1::FIELD_BOOL, encoded);
}

Sample& Sample::setI8(uint8_t field_id, int8_t value) {
  device::v1::SampleValue encoded = {};
  encoded.i8_value = value;
  return setValue(field_id, device::v1::FIELD_I8, encoded);
}

Sample& Sample::setU8(uint8_t field_id, uint8_t value) {
  device::v1::SampleValue encoded = {};
  encoded.u8_value = value;
  return setValue(field_id, device::v1::FIELD_U8, encoded);
}

Sample& Sample::setI16(uint8_t field_id, int16_t value) {
  device::v1::SampleValue encoded = {};
  encoded.i16_value = value;
  return setValue(field_id, device::v1::FIELD_I16, encoded);
}

Sample& Sample::setU16(uint8_t field_id, uint16_t value) {
  device::v1::SampleValue encoded = {};
  encoded.u16_value = value;
  return setValue(field_id, device::v1::FIELD_U16, encoded);
}

Sample& Sample::setI32(uint8_t field_id, int32_t value) {
  device::v1::SampleValue encoded = {};
  encoded.i32_value = value;
  return setValue(field_id, device::v1::FIELD_I32, encoded);
}

Sample& Sample::setU32(uint8_t field_id, uint32_t value) {
  device::v1::SampleValue encoded = {};
  encoded.u32_value = value;
  return setValue(field_id, device::v1::FIELD_U32, encoded);
}

Sample& Sample::setF32(uint8_t field_id, float value) {
  device::v1::SampleValue encoded = {};
  encoded.f32_value = value;
  return setValue(field_id, device::v1::FIELD_F32, encoded);
}

Sample& Sample::setF64(uint8_t field_id, double value) {
  device::v1::SampleValue encoded = {};
  encoded.f64_value = value;
  return setValue(field_id, device::v1::FIELD_F64, encoded);
}

CommitResult Sample::commit() {
  if (committed_ || invalid_ || logger_ == nullptr) {
    committed_ = true;
    return CommitResult::Invalid;
  }
  committed_ = true;
  return logger_->commitSample(raw_micros_, schema_id_, revision_, anchor_id_,
                               field_count_, fields_);
}

bool Sample::valid() const { return !invalid_ && !committed_; }

Logger::Logger()
    : config_(),
      journal_(),
      core_(journal_),
      client_(),
      matrix_(),
      in_flight_(),
      state_(State::Idle),
      led_state_(LedState::Unknown),
      response_phase_(ResponsePhase::Idle),
      response_line_size_(0),
      response_body_size_(0),
      response_header_bytes_(0),
      response_status_(0),
      response_content_length_(0),
      response_deadline_ms_(0),
      response_server_utc_ns_(0),
      request_sent_mono_us_(0),
      next_wifi_attempt_ms_(0),
      dhcp_deadline_ms_(0),
      next_upload_attempt_ms_(0),
      next_rssi_ms_(0),
      next_sntp_ms_(0),
      next_wifi_status_ms_(0),
      last_sample_commit_ms_(0),
      acknowledged_frames_(0),
      wifi_connect_attempts_(0),
      transport_failures_(0),
      last_reported_drops_(0),
      cached_rssi_dbm_(0),
      active_anchor_id_(0),
      next_anchor_id_(1),
      wifi_backoff_exponent_(0),
      upload_backoff_exponent_(0),
      frame_send_count_(0),
      started_(false),
      wifi_ready_(false),
      dhcp_waiting_(false),
      frame_active_(false),
      response_content_length_seen_(false),
      response_content_type_seen_(false),
      response_server_utc_seen_(false),
      response_line_truncated_(false),
      response_first_line_(true),
      matrix_ready_(false),
      cached_rssi_valid_(false),
      have_any_anchor_(false),
      have_sntp_anchor_(false),
      last_http_status_(0) {
  memset(schemas_, 0, sizeof(schemas_));
  memset(&in_flight_, 0, sizeof(in_flight_));
  memset(run_id_hex_, 0, sizeof(run_id_hex_));
  memset(response_line_, 0, sizeof(response_line_));
  memset(response_body_, 0, sizeof(response_body_));
}

uint8_t Logger::boundedLength(const char* text, uint8_t maximum, bool* valid) {
  if (valid == nullptr) return 0;
  if (text == nullptr) {
    *valid = false;
    return 0;
  }
  uint8_t length = 0;
  while (length < maximum && text[length] != '\0') ++length;
  if (length == maximum && text[length] != '\0') {
    *valid = false;
    return 0;
  }
  *valid = true;
  return length;
}

bool Logger::headerValueSafe(const char* text, bool allow_empty) {
  if (text == nullptr || (!allow_empty && text[0] == '\0')) return false;
  for (size_t index = 0; text[index] != '\0'; ++index) {
    const uint8_t value = static_cast<uint8_t>(text[index]);
    if (value < 0x20 || value > 0x7e || value == ',') return false;
  }
  return true;
}

bool Logger::validateConfig(const Config& config) const {
  bool valid = false;
  const uint8_t ssid_length = boundedLength(config.ssid, 33, &valid);
  if (!valid || ssid_length == 0 || ssid_length > 32 ||
      !headerValueSafe(config.ssid, false)) {
    return false;
  }

  if (config.password != nullptr && config.password[0] != '\0') {
    const uint8_t password_length = boundedLength(config.password, 65, &valid);
    if (!valid || (password_length != 64 &&
                   (password_length < 8 || password_length > 63)) ||
        !headerValueSafe(config.password, false)) {
      return false;
    }
    if (password_length == 64) {
      for (uint8_t index = 0; index < password_length; ++index) {
        const char value = config.password[index];
        if (!((value >= '0' && value <= '9') ||
              (value >= 'a' && value <= 'f') ||
              (value >= 'A' && value <= 'F'))) {
          return false;
        }
      }
    }
  }

  const uint8_t key_length = boundedLength(config.api_key, 201, &valid);
  if (!valid || key_length == 0 || !headerValueSafe(config.api_key, false)) {
    return false;
  }
  const uint8_t device_length = boundedLength(config.device_id, 33, &valid);
  if (!valid || device_length == 0 || device_length > 32) return false;
  for (uint8_t index = 0; index < device_length; ++index) {
    const char value = config.device_id[index];
    if (!((value >= 'A' && value <= 'Z') ||
          (value >= 'a' && value <= 'z') ||
          (value >= '0' && value <= '9') || value == '_' || value == '-')) {
      return false;
    }
  }

  const uint8_t mesh_length = boundedLength(config.mesh_path, 129, &valid);
  if (!valid || mesh_length == 0 || !headerValueSafe(config.mesh_path, false)) {
    return false;
  }
  if (config.mesh_path[0] == '/' || config.mesh_path[mesh_length - 1] == '/') {
    return false;
  }
  for (uint8_t index = 0; index < mesh_length; ++index) {
    const char value = config.mesh_path[index];
    if (!((value >= 'A' && value <= 'Z') ||
          (value >= 'a' && value <= 'z') ||
          (value >= '0' && value <= '9') || value == '_' || value == '-' ||
          value == '/')) {
      return false;
    }
  }
  const uint8_t host_length = boundedLength(config.host, 97, &valid);
  if (!valid || host_length == 0 || !headerValueSafe(config.host, false)) {
    return false;
  }
  for (uint8_t index = 0; index < host_length; ++index) {
    const char value = config.host[index];
    if (!((value >= 'A' && value <= 'Z') ||
          (value >= 'a' && value <= 'z') ||
          (value >= '0' && value <= '9') || value == '.' || value == '-')) {
      return false;
    }
  }
  const uint8_t path_length = boundedLength(config.request_path, 97, &valid);
  if (!valid || path_length == 0 || config.request_path[0] != '/' ||
      !headerValueSafe(config.request_path, false)) {
    return false;
  }
  for (uint8_t index = 1; index < path_length; ++index) {
    const char value = config.request_path[index];
    if (!((value >= 'A' && value <= 'Z') ||
          (value >= 'a' && value <= 'z') ||
          (value >= '0' && value <= '9') || value == '_' || value == '-' ||
          value == '/')) {
      return false;
    }
  }
  const uint8_t firmware_length = boundedLength(config.firmware, 33, &valid);
  if (!valid || firmware_length > 32) return false;
  const uint8_t mission_length = boundedLength(config.mission, 65, &valid);
  if (!valid || mission_length > 64) return false;
  if (!detail::validCustomCaEnvelope(config.ca_cert)) return false;
  if (config.port == 0 || config.wifi_connect_timeout_ms == 0 ||
      config.dhcp_timeout_ms == 0 || config.tls_connect_timeout_ms == 0 ||
      config.response_timeout_ms == 0) {
    return false;
  }
  if (config.tls_connect_timeout_ms > 10000 ||
      config.wifi_connect_timeout_ms > 60000 ||
      config.dhcp_timeout_ms > 60000 || config.response_timeout_ms > 60000 ||
      (config.finalize_after_ms != 0 &&
       (config.finalize_after_ms < 1000 ||
        config.finalize_after_ms > 99999999))) {
    return false;
  }
  return true;
}

BeginResult Logger::begin(const Config& config) {
  if (started_) return BeginResult::Faulted;
  if (!validateConfig(config)) return BeginResult::InvalidConfig;
  config_ = config;
  if (!client_.setCustomCa(config_.ca_cert)) {
    return BeginResult::InvalidConfig;
  }

  if (config_.use_led_matrix) {
    matrix_ready_ = matrix_.begin();
  }
  if (matrix_ready_) setLed(LedState::Connecting);

  device::v1::RunId run_id = {};
  const detail::RunIdResult entropy = detail::generateRunId(run_id.bytes);
  if (entropy != detail::RunIdResult::Ok) {
    setState(State::Faulted);
    if (entropy == detail::RunIdResult::InitFailed) {
      diagnose(F("alloy uno: SCE initialization failed"));
      return BeginResult::EntropyInitFailed;
    }
    if (entropy == detail::RunIdResult::ReadFailed) {
      diagnose(F("alloy uno: SCE random read failed"));
      return BeginResult::EntropyReadFailed;
    }
    diagnose(F("alloy uno: SCE returned an all-zero run id"));
    return BeginResult::EntropyAllZero;
  }

  static const char kHex[] = "0123456789abcdef";
  for (uint8_t index = 0; index < 16; ++index) {
    run_id_hex_[index * 2] = kHex[run_id.bytes[index] >> 4];
    run_id_hex_[index * 2 + 1] = kHex[run_id.bytes[index] & 0x0f];
  }
  run_id_hex_[32] = '\0';

  bool valid = false;
  const uint8_t device_length = boundedLength(config_.device_id, 33, &valid);
  const uint8_t firmware_length = boundedLength(config_.firmware, 33, &valid);
  const uint8_t mission_length = boundedLength(config_.mission, 65, &valid);
  const uint32_t raw_micros = micros();
  device::v1::RunBeginPayload begin_payload = {};
  begin_payload.device = {config_.device_id, device_length};
  begin_payload.firmware = {config_.firmware, firmware_length};
  begin_payload.mission = {config_.mission, mission_length};
  begin_payload.reliability = device::v1::VOLATILE_BEST_EFFORT;
  begin_payload.boot_reason = 0;
  begin_payload.mono_start_us = raw_micros;
  if (core_.begin(run_id, raw_micros, begin_payload) != device::v1::COMMIT_OK) {
    setState(State::Faulted);
    diagnose(F("alloy uno: core rejected RUN_BEGIN"));
    return BeginResult::CoreRejected;
  }

  static const char kBoardName[] = "Arduino UNO R4 WiFi";
  static const char kCoreName[] = "Alloy Device v1";
  static const char kRadioName[] = "ESP32-S3 WiFiS3";
  uint64_t capability_bits =
      device::v1::CAPABILITY_VERIFIED_TLS |
      device::v1::CAPABILITY_UTC_ANCHORS |
      device::v1::CAPABILITY_BACKPRESSURE |
      device::v1::CAPABILITY_CACHED_RSSI |
      device::v1::CAPABILITY_ANALOG_SAMPLING |
      device::v1::CAPABILITY_DIGITAL_SAMPLING;
  if (matrix_ready_) capability_bits |= device::v1::CAPABILITY_LED_MATRIX;

  device::v1::CapabilitiesPayload capabilities = {};
  capabilities.board_code = 1;
  capabilities.adapter_revision = 1;
  capabilities.capability_bits = capability_bits;
  capabilities.maximum_frame_bytes = device::v1::kUnoFrameBytes;
  capabilities.journal_slots = device::v1::kJournalSlotCount;
  capabilities.journal_slot_bytes = device::v1::kJournalSlotBytes;
  capabilities.maximum_schemas = device::v1::kCoreMaxSchemas;
  capabilities.maximum_fields_per_schema = device::v1::kMaxFieldsPerSchema;
  capabilities.journal_kind = device::v1::JOURNAL_RAM;
  capabilities.active_reliability = device::v1::VOLATILE_BEST_EFFORT;
  capabilities.monotonic_resolution_us = 1;
  capabilities.scheduler_kind = device::v1::SCHEDULER_COOPERATIVE;
  capabilities.board = {kBoardName, sizeof(kBoardName) - 1};
  capabilities.core = {kCoreName, sizeof(kCoreName) - 1};
  capabilities.radio = {kRadioName, sizeof(kRadioName) - 1};
  if (core_.commitCapabilities(capabilities) != device::v1::COMMIT_OK) {
    setState(State::Faulted);
    diagnose(F("alloy uno: core rejected CAPABILITIES"));
    return BeginResult::CoreRejected;
  }

  WiFi.setTimeout(config_.wifi_connect_timeout_ms);
  started_ = true;
  next_wifi_attempt_ms_ = millis();
  next_upload_attempt_ms_ = next_wifi_attempt_ms_;
  setState(State::Connecting);
  diagnose(F("alloy uno: started; call poll() cooperatively"));
  return BeginResult::Started;
}

CommitResult Logger::declareSchema(uint16_t schema_id, uint16_t revision,
                                   const char* channel, const Field* fields,
                                   uint8_t field_count) {
  if (!started_ || fields == nullptr || field_count == 0 ||
      field_count > device::v1::kMaxFieldsPerSchema) {
    return CommitResult::Invalid;
  }

  bool valid = false;
  const uint8_t channel_length = boundedLength(channel, 25, &valid);
  if (!valid || channel_length == 0 || channel_length > 24) {
    return CommitResult::Invalid;
  }
  device::v1::FieldDescriptor descriptors[device::v1::kMaxFieldsPerSchema] = {};
  for (uint8_t index = 0; index < field_count; ++index) {
    const uint8_t name_length = boundedLength(fields[index].name, 25, &valid);
    if (!valid || name_length == 0 || name_length > 24) {
      return CommitResult::Invalid;
    }
    const char* unit = fields[index].unit == nullptr ? "" : fields[index].unit;
    const uint8_t unit_length = boundedLength(unit, 13, &valid);
    if (!valid || unit_length > 12) return CommitResult::Invalid;
    descriptors[index].field_id = fields[index].id;
    descriptors[index].type = fields[index].type;
    descriptors[index].flags = 0;
    descriptors[index].name = {fields[index].name, name_length};
    descriptors[index].unit = {unit, unit_length};
  }

  device::v1::SchemaPayload schema = {};
  schema.schema_id = schema_id;
  schema.revision = revision;
  schema.channel = {channel, channel_length};
  schema.field_count = field_count;
  schema.fields = descriptors;
  const device::v1::CommitStatus status = core_.commitSchema(schema);
  if (status != device::v1::COMMIT_OK) return mapCommitStatus(status);

  SchemaCache* destination = nullptr;
  for (uint8_t index = 0; index < device::v1::kCoreMaxSchemas; ++index) {
    if (!schemas_[index].used) {
      destination = &schemas_[index];
      break;
    }
  }
  if (destination == nullptr) return CommitResult::Faulted;
  destination->used = true;
  destination->schema_id = schema_id;
  destination->revision = revision;
  destination->field_count = field_count;
  for (uint8_t index = 0; index < field_count; ++index) {
    destination->field_types[index] =
        static_cast<uint8_t>(fields[index].type);
  }
  return CommitResult::Accepted;
}

const Logger::SchemaCache* Logger::findSchema(uint16_t schema_id,
                                               uint16_t revision) const {
  for (uint8_t index = 0; index < device::v1::kCoreMaxSchemas; ++index) {
    if (schemas_[index].used && schemas_[index].schema_id == schema_id &&
        schemas_[index].revision == revision) {
      return &schemas_[index];
    }
  }
  return nullptr;
}

Sample Logger::sample(uint16_t schema_id, uint16_t revision) {
  const SchemaCache* schema = findSchema(schema_id, revision);
  if (!started_ || schema == nullptr || core_.state() != device::v1::CORE_CAPTURING) {
    return Sample(nullptr, schema_id, revision, 0, 0, 0, nullptr);
  }
  return Sample(this, schema_id, revision, active_anchor_id_, micros(),
                schema->field_count, schema->field_types);
}

CommitResult Logger::commitSample(
    uint32_t raw_micros, uint16_t schema_id, uint16_t revision,
    uint16_t anchor_id, uint8_t field_count,
    const device::v1::SampleFieldValue* fields) {
  device::v1::SampleInput input = {};
  input.schema_id = schema_id;
  input.revision = revision;
  input.anchor_id = anchor_id;
  input.field_count = field_count;
  input.fields = fields;
  const device::v1::SampleCommitResult result = core_.commitSample(raw_micros, input);
  switch (result.status) {
    case device::v1::SAMPLE_COMMITTED:
      last_sample_commit_ms_ = millis();
      return CommitResult::Accepted;
    case device::v1::SAMPLE_DROPPED_NEWEST:
    case device::v1::SAMPLE_WOULD_BLOCK:
      return CommitResult::WouldBlock;
    case device::v1::SAMPLE_ENCODER_REJECTED:
    case device::v1::SAMPLE_CLOCK_REGRESSION:
    case device::v1::SAMPLE_UNKNOWN_SCHEMA:
    case device::v1::SAMPLE_CLOSED:
      return CommitResult::Invalid;
    case device::v1::SAMPLE_FAULTED:
    case device::v1::SAMPLE_SEQUENCE_EXHAUSTED:
      return CommitResult::Faulted;
  }
  return CommitResult::Faulted;
}

CommitResult Logger::end() {
  if (!started_) return CommitResult::Invalid;
  return mapCommitStatus(
      core_.end(micros(), device::v1::RUN_END_EXPLICIT, 0));
}

bool Logger::due(uint32_t now_ms, uint32_t deadline_ms) {
  return static_cast<int32_t>(now_ms - deadline_ms) >= 0;
}

uint32_t Logger::boundedBackoff(uint8_t exponent) {
  if (exponent > 6) exponent = 6;
  uint32_t value = 500ul << exponent;
  return value > kMaximumBackoffMs ? kMaximumBackoffMs : value;
}

void Logger::scheduleWifiRetry(uint32_t now_ms) {
  client_.stop();
  wifi_ready_ = false;
  dhcp_waiting_ = false;
  next_wifi_attempt_ms_ = now_ms + boundedBackoff(wifi_backoff_exponent_);
  if (wifi_backoff_exponent_ < 7) ++wifi_backoff_exponent_;
  setState(State::Backoff);
}

bool Logger::serviceWifi(uint32_t now_ms) {
  if (wifi_ready_) {
    if (!due(now_ms, next_wifi_status_ms_)) return true;
    next_wifi_status_ms_ = now_ms + 500;
    if (WiFi.status() == WL_CONNECTED) return true;
    diagnose(F("alloy uno: WiFi link lost"));
    scheduleWifiRetry(now_ms);
    return false;
  }

  if (dhcp_waiting_) {
    if (!due(now_ms, next_wifi_status_ms_)) return false;
    next_wifi_status_ms_ = now_ms + 250;
    if (WiFi.status() != WL_CONNECTED) {
      diagnose(F("alloy uno: association lost before DHCP"));
      scheduleWifiRetry(now_ms);
      return false;
    }
    const IPAddress local = WiFi.localIP();
    const IPAddress gateway = WiFi.gatewayIP();
    const IPAddress subnet = WiFi.subnetMask();
    const IPAddress dns = WiFi.dnsIP();
    if (!isZeroAddress(local) && !isZeroAddress(gateway) &&
        !isZeroAddress(subnet) && !isZeroAddress(dns)) {
      dhcp_waiting_ = false;
      wifi_ready_ = true;
      wifi_backoff_exponent_ = 0;
      next_wifi_status_ms_ = now_ms + 500;
      next_rssi_ms_ = now_ms;
      next_sntp_ms_ = now_ms;
      setState(State::Online);
      diagnose(F("alloy uno: WiFi and DHCP ready"));
      return true;
    }
    if (due(now_ms, dhcp_deadline_ms_)) {
      WiFi.disconnect();
      diagnose(F("alloy uno: DHCP/DNS configuration timed out"));
      scheduleWifiRetry(now_ms);
    }
    return false;
  }

  if (!due(now_ms, next_wifi_attempt_ms_)) return false;
  if (WiFi.status() == WL_NO_MODULE) {
    setState(State::Faulted);
    diagnose(F("alloy uno: WiFiS3 module missing"));
    return false;
  }

  ++wifi_connect_attempts_;
  setState(State::Connecting);
  const int status = config_.password != nullptr && config_.password[0] != '\0'
                         ? WiFi.begin(config_.ssid, config_.password)
                         : WiFi.begin(config_.ssid);
  if (status != WL_CONNECTED) {
    diagnose(F("alloy uno: WiFi association failed"));
    scheduleWifiRetry(millis());
    return false;
  }
  dhcp_waiting_ = true;
  const uint32_t connected_ms = millis();
  dhcp_deadline_ms_ = connected_ms + config_.dhcp_timeout_ms;
  next_wifi_status_ms_ = connected_ms;
  return serviceWifi(connected_ms);
}

void Logger::serviceRssi(uint32_t now_ms) {
  if (!due(now_ms, next_rssi_ms_)) return;
  cached_rssi_dbm_ = WiFi.RSSI();
  cached_rssi_valid_ = true;
  next_rssi_ms_ = now_ms + kRssiIntervalMs;
}

bool Logger::refreshMonotonic(uint64_t* mono_us) {
  if (mono_us == nullptr || !core_.pollMicros(micros())) return false;
  *mono_us = core_.monotonicMicros();
  return true;
}

bool Logger::queueAnchor(device::v1::AnchorSource source,
                         device::v1::AnchorQuality quality, uint64_t mono_us,
                         uint64_t utc_ns, uint32_t uncertainty_us) {
  if (next_anchor_id_ == 0 || utc_ns == 0) return false;
  device::v1::UtcAnchorPayload anchor = {};
  anchor.anchor_id = next_anchor_id_;
  anchor.source = source;
  anchor.quality = quality;
  anchor.uncertainty_us = uncertainty_us;
  anchor.mono_us = mono_us;
  anchor.utc_ns = utc_ns;
  anchor.frequency_error_ppb = INT32_MIN;
  if (core_.commitUtcAnchor(anchor) != device::v1::COMMIT_OK) return false;
  active_anchor_id_ = next_anchor_id_;
  ++next_anchor_id_;
  have_any_anchor_ = true;
  if (source == device::v1::ANCHOR_SNTP) have_sntp_anchor_ = true;
  return true;
}

void Logger::serviceClockAnchors(uint32_t now_ms) {
  if (!due(now_ms, next_sntp_ms_)) return;
  uint64_t before_us = 0;
  uint64_t after_us = 0;
  if (!refreshMonotonic(&before_us)) return;
  const unsigned long epoch_seconds = WiFi.getTime();
  if (!refreshMonotonic(&after_us)) return;
  if (epoch_seconds == 0) {
    next_sntp_ms_ = now_ms + kSntpRetryMs;
    return;
  }
  const uint64_t round_trip_us = after_us - before_us;
  const uint64_t uncertainty = 1000000ull + round_trip_us;
  if (queueAnchor(device::v1::ANCHOR_SNTP,
                  device::v1::ANCHOR_SYNCHRONIZED,
                  before_us + round_trip_us / 2,
                  static_cast<uint64_t>(epoch_seconds) * 1000000000ull,
                  uncertainty > UINT32_MAX ? UINT32_MAX
                                           : static_cast<uint32_t>(uncertainty))) {
    diagnose(F("alloy uno: synchronized UTC anchor queued"));
  }
  next_sntp_ms_ = now_ms + (have_sntp_anchor_ ? kSntpRefreshMs : kSntpRetryMs);
}

bool Logger::writeText(WiFiSSLClient& client, const char* text) {
  if (text == nullptr) return false;
  const size_t size = strlen(text);
  return size == 0 || client.write(reinterpret_cast<const uint8_t*>(text), size) == size;
}

bool Logger::writeUnsigned(WiFiSSLClient& client, uint32_t value) {
  char digits[10];
  uint8_t count = 0;
  do {
    digits[count++] = static_cast<char>('0' + value % 10);
    value /= 10;
  } while (value != 0 && count < sizeof(digits));
  for (uint8_t index = 0; index < count / 2; ++index) {
    const char swap = digits[index];
    digits[index] = digits[count - index - 1];
    digits[count - index - 1] = swap;
  }
  return client.write(reinterpret_cast<const uint8_t*>(digits), count) == count;
}

bool Logger::startRequest() {
  client_.stop();
  client_.setConnectionTimeout(config_.tls_connect_timeout_ms);
  if (!client_.connect(config_.host, config_.port)) {
    transportFailure(millis(), false);
    return false;
  }

  if (frame_send_count_ > 0) core_.noteRetryAttempt();
  uint64_t sent_mono_us = 0;
  if (!refreshMonotonic(&sent_mono_us)) {
    transportFailure(millis(), false);
    return false;
  }
  request_sent_mono_us_ = sent_mono_us;
  if (frame_send_count_ < UINT8_MAX) ++frame_send_count_;

  bool wrote = writeText(client_, "POST ") &&
               writeText(client_, config_.request_path) &&
               writeText(client_, " HTTP/1.1\r\nHost: ") &&
               writeText(client_, config_.host);
  if (wrote && config_.port != 443) {
    wrote = writeText(client_, ":") && writeUnsigned(client_, config_.port);
  }
  wrote = wrote &&
          writeText(client_,
                    "\r\nContent-Type: application/vnd.alloy.frame;version=1"
                    "\r\nAuthorization: Bearer ") &&
          writeText(client_, config_.api_key) &&
          writeText(client_, "\r\nX-Alloy-Device: ") &&
          writeText(client_, config_.device_id) &&
          writeText(client_, "\r\nX-Alloy-Run: ") &&
          writeText(client_, run_id_hex_) &&
          writeText(client_, "\r\nX-Alloy-Mesh-Path: ") &&
          writeText(client_, config_.mesh_path);
  if (wrote && config_.finalize_after_ms != 0) {
    wrote = writeText(client_, "\r\nX-Alloy-Finalize-Ms: ") &&
            writeUnsigned(client_, config_.finalize_after_ms);
  }
  wrote = wrote && writeText(client_, "\r\nContent-Length: ") &&
          writeUnsigned(client_, in_flight_.size) &&
          writeText(client_, "\r\nConnection: close\r\n\r\n") &&
          client_.write(in_flight_.bytes, in_flight_.size) == in_flight_.size;
  if (!wrote) {
    transportFailure(millis(), true);
    return false;
  }

  resetResponse();
  response_phase_ = ResponsePhase::Headers;
  response_deadline_ms_ = millis() + config_.response_timeout_ms;
  setState(State::Uploading);
  return true;
}

void Logger::resetResponse() {
  response_phase_ = ResponsePhase::Idle;
  response_line_size_ = 0;
  response_body_size_ = 0;
  response_header_bytes_ = 0;
  response_status_ = 0;
  response_content_length_ = 0;
  response_server_utc_ns_ = 0;
  response_content_length_seen_ = false;
  response_content_type_seen_ = false;
  response_server_utc_seen_ = false;
  response_line_truncated_ = false;
  response_first_line_ = true;
}

void Logger::parseResponseLine() {
  response_line_[response_line_size_] = '\0';
  if (response_line_truncated_) {
    response_phase_ = ResponsePhase::Invalid;
    return;
  }

  if (response_first_line_) {
    response_first_line_ = false;
    if (response_line_size_ < 12 ||
        !(memcmp(response_line_, "HTTP/1.1 ", 9) == 0 ||
          memcmp(response_line_, "HTTP/1.0 ", 9) == 0) ||
        response_line_[9] < '1' || response_line_[9] > '5' ||
        response_line_[10] < '0' || response_line_[10] > '9' ||
        response_line_[11] < '0' || response_line_[11] > '9') {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    response_status_ = static_cast<uint16_t>(
        (response_line_[9] - '0') * 100 + (response_line_[10] - '0') * 10 +
        (response_line_[11] - '0'));
    return;
  }

  if (response_line_size_ == 0) {
    if (response_status_ == 401 || response_status_ == 403) {
      response_phase_ = ResponsePhase::Complete;
      return;
    }
    if (!response_content_length_seen_ || !response_content_type_seen_ ||
        response_content_length_ != device::v1::kAckBytes) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    response_phase_ = ResponsePhase::Body;
    return;
  }

  char* colon = static_cast<char*>(memchr(response_line_, ':', response_line_size_));
  if (colon == nullptr) {
    response_phase_ = ResponsePhase::Invalid;
    return;
  }
  const size_t name_size = static_cast<size_t>(colon - response_line_);
  const char* value = colon + 1;
  const char* end = response_line_ + response_line_size_;
  while (value < end && (*value == ' ' || *value == '\t')) ++value;
  while (end > value && (end[-1] == ' ' || end[-1] == '\t')) --end;
  const size_t value_size = static_cast<size_t>(end - value);

  if (asciiEqualIgnoreCase(response_line_, name_size, "Content-Length")) {
    if (response_content_length_seen_) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    uint64_t parsed = 0;
    if (!parseUnsigned64(value, value_size, &parsed) || parsed > UINT16_MAX) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    response_content_length_ = static_cast<uint16_t>(parsed);
    response_content_length_seen_ = true;
  } else if (asciiEqualIgnoreCase(response_line_, name_size, "Content-Type")) {
    if (response_content_type_seen_ ||
        !asciiEqualIgnoreCase(value, value_size,
                              "application/vnd.alloy.ack;version=1")) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    response_content_type_seen_ = true;
  } else if (asciiEqualIgnoreCase(response_line_, name_size,
                                  "X-Alloy-Server-UTC-Ns")) {
    if (response_server_utc_seen_ ||
        !parseUnsigned64(value, value_size, &response_server_utc_ns_) ||
        response_server_utc_ns_ == 0) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    response_server_utc_seen_ = true;
  } else if (asciiEqualIgnoreCase(response_line_, name_size,
                                  "Transfer-Encoding")) {
    response_phase_ = ResponsePhase::Invalid;
  }
}

void Logger::consumeResponseByte(uint8_t byte) {
  if (response_phase_ == ResponsePhase::Headers) {
    if (++response_header_bytes_ > kMaximumHttpHeaderBytes) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    if (byte == '\r') return;
    if (byte == '\n') {
      parseResponseLine();
      response_line_size_ = 0;
      response_line_truncated_ = false;
      return;
    }
    if (static_cast<size_t>(response_line_size_) + 1 < sizeof(response_line_)) {
      response_line_[response_line_size_++] = static_cast<char>(byte);
    } else {
      response_line_truncated_ = true;
    }
    return;
  }

  if (response_phase_ == ResponsePhase::Body) {
    if (response_body_size_ >= device::v1::kAckBytes) {
      response_phase_ = ResponsePhase::Invalid;
      return;
    }
    response_body_[response_body_size_++] = byte;
    if (response_body_size_ == device::v1::kAckBytes) {
      response_phase_ = ResponsePhase::Complete;
    }
  }
}

void Logger::serviceResponse(uint32_t now_ms) {
  uint16_t consumed = 0;
  while (consumed < 256 && client_.available() > 0 &&
         (response_phase_ == ResponsePhase::Headers ||
          response_phase_ == ResponsePhase::Body)) {
    const int value = client_.read();
    if (value < 0) break;
    consumeResponseByte(static_cast<uint8_t>(value));
    ++consumed;
  }

  if (response_phase_ == ResponsePhase::Complete) {
    uint64_t received_mono_us = 0;
    refreshMonotonic(&received_mono_us);
    finishResponse(received_mono_us);
    return;
  }
  if (response_phase_ == ResponsePhase::Invalid ||
      due(now_ms, response_deadline_ms_) ||
      (client_.available() == 0 && !client_.connected())) {
    transportFailure(now_ms, true);
  }
}

void Logger::finishResponse(uint64_t received_mono_us) {
  client_.stop();
  last_http_status_ = response_status_;
  if (response_status_ == 401 || response_status_ == 403) {
    resetResponse();
    core_.enterAuthBlocked();
    setState(State::AuthBlocked);
    diagnose(F("alloy uno: authorization blocked (HTTP 401/403)"));
    return;
  }

  device::v1::Ack ack = {};
  const device::v1::AckValidation validation =
      device::v1::decodeAndValidateAck(
          response_body_, response_body_size_, core_.runId(),
          in_flight_.frame_seq, in_flight_.crc32c, &ack);
  if (validation != device::v1::ACK_VALID ||
      ((ack.status == device::v1::ACK_ACCEPTED ||
        ack.status == device::v1::ACK_DUPLICATE) &&
       (response_status_ < 200 || response_status_ >= 300))) {
    resetResponse();
    transportFailure(millis(), true);
    return;
  }

  const bool can_anchor = response_server_utc_seen_ && !have_any_anchor_ &&
                          received_mono_us >= request_sent_mono_us_;
  const uint64_t server_utc_ns = response_server_utc_ns_;
  const uint64_t round_trip_us =
      can_anchor ? received_mono_us - request_sent_mono_us_ : 0;
  const uint64_t anchor_mono_us = request_sent_mono_us_ + round_trip_us / 2;
  resetResponse();

  const device::v1::AckDisposition disposition =
      core_.handleAck(response_body_, device::v1::kAckBytes, &ack);
  frame_active_ = core_.hasInFlight();
  if (can_anchor &&
      (disposition == device::v1::ACK_RECLAIMED ||
       disposition == device::v1::ACK_RETAINED_RETRY)) {
    const uint64_t uncertainty = round_trip_us + 1000ull;
    if (queueAnchor(device::v1::ANCHOR_AUTHENTICATED_HOST,
                    device::v1::ANCHOR_APPROXIMATE, anchor_mono_us,
                    server_utc_ns,
                    uncertainty > UINT32_MAX
                        ? UINT32_MAX
                        : static_cast<uint32_t>(uncertainty))) {
      diagnose(F("alloy uno: authenticated host UTC anchor queued"));
    }
  }

  switch (disposition) {
    case device::v1::ACK_RECLAIMED:
      ++acknowledged_frames_;
      upload_backoff_exponent_ = 0;
      frame_send_count_ = 0;
      next_upload_attempt_ms_ = millis();
      setState(State::Online);
      if (config_.diagnostics != nullptr) {
        config_.diagnostics->print(F("alloy uno: acknowledged frame "));
        config_.diagnostics->println(ack.frame_seq);
      }
      return;
    case device::v1::ACK_RETAINED_RETRY:
      scheduleUploadRetry(millis(), ack.retry_after_ms);
      return;
    case device::v1::ACK_ENTERED_AUTH_BLOCKED:
      setState(State::AuthBlocked);
      diagnose(F("alloy uno: ACK entered authorization-blocked state"));
      return;
    case device::v1::ACK_ENTERED_STALE:
      setState(State::Stale);
      diagnose(F("alloy uno: run was already finalized"));
      return;
    case device::v1::ACK_ENTERED_FAULT:
      setState(State::Faulted);
      diagnose(F("alloy uno: terminal ACK faulted the run"));
      return;
    case device::v1::ACK_REJECTED_MALFORMED:
      transportFailure(millis(), true);
      return;
    case device::v1::ACK_NO_IN_FLIGHT:
      setState(State::Faulted);
      diagnose(F("alloy uno: ACK arrived without an in-flight frame"));
      return;
  }
}

void Logger::scheduleUploadRetry(uint32_t now_ms, uint32_t requested_ms) {
  uint32_t wait_ms = requested_ms == 0 ? boundedBackoff(upload_backoff_exponent_)
                                        : requested_ms;
  if (wait_ms < 250) wait_ms = 250;
  if (wait_ms > kMaximumBackoffMs) wait_ms = kMaximumBackoffMs;
  next_upload_attempt_ms_ = now_ms + wait_ms;
  if (upload_backoff_exponent_ < 7) ++upload_backoff_exponent_;
  setState(State::Backoff);
}

void Logger::transportFailure(uint32_t now_ms, bool request_was_sent) {
  client_.stop();
  resetResponse();
  ++transport_failures_;
  if (request_was_sent && frame_active_) {
    scheduleUploadRetry(now_ms, 0);
  } else {
    scheduleUploadRetry(now_ms, 0);
  }
  diagnose(F("alloy uno: transport failed; frame retained"));
}

void Logger::serviceNetwork(uint32_t now_ms) {
  if (response_phase_ == ResponsePhase::Headers ||
      response_phase_ == ResponsePhase::Body) {
    serviceResponse(now_ms);
    return;
  }
  if (!due(now_ms, next_upload_attempt_ms_)) return;

  if (!frame_active_) {
    core_.flushPendingGap();
    if (!core_.acquireInFlight(&in_flight_)) {
      setState(State::Online);
      return;
    }
    frame_active_ = true;
    frame_send_count_ = 0;
  }
  startRequest();
}

void Logger::poll() {
  if (!started_) return;
  const uint32_t now_ms = millis();
  core_.pollMicros(micros());
  core_.flushPendingGap();
  if (core_.hasBuilder() &&
      due(now_ms, last_sample_commit_ms_ + kSampleFlushLatencyMs)) {
    core_.flushSamples();
  }

  switch (core_.state()) {
    case device::v1::CORE_COMPLETE:
      setState(State::Complete);
      return;
    case device::v1::CORE_AUTH_BLOCKED:
      setState(State::AuthBlocked);
      return;
    case device::v1::CORE_STALE:
      setState(State::Stale);
      return;
    case device::v1::CORE_FAULTED:
      setState(State::Faulted);
      return;
    default:
      break;
  }

  if (response_phase_ == ResponsePhase::Headers ||
      response_phase_ == ResponsePhase::Body) {
    serviceResponse(now_ms);
  } else if (serviceWifi(now_ms)) {
    serviceRssi(now_ms);
    serviceClockAnchors(now_ms);
    serviceNetwork(now_ms);
  }

  const uint32_t drops = core_.stats().frame.dropped_samples;
  if (drops != last_reported_drops_) {
    last_reported_drops_ = drops;
    if (config_.diagnostics != nullptr) {
      config_.diagnostics->print(F("alloy uno: cumulative dropped samples "));
      config_.diagnostics->println(drops);
    }
  }
}

State Logger::state() const { return state_; }

Stats Logger::stats() const {
  const device::v1::CoreStats& core_stats = core_.stats();
  Stats result = {};
  result.attempted_samples = core_stats.attempted_samples;
  result.encoded_samples = core_stats.encoded_samples;
  result.dropped_samples = core_stats.frame.dropped_samples;
  result.dropped_frames = core_stats.frame.dropped_frames;
  result.corrupt_frames = core_stats.frame.corrupt_frames;
  result.backpressure_events = core_stats.frame.backpressure_events;
  result.retry_attempts = core_stats.frame.retries;
  result.acknowledged_frames = acknowledged_frames_;
  result.wifi_connect_attempts = wifi_connect_attempts_;
  result.transport_failures = transport_failures_;
  result.journal_used = static_cast<uint16_t>(core_.journalUsed());
  result.cached_rssi_dbm = cached_rssi_dbm_;
  result.cached_rssi_valid = cached_rssi_valid_;
  result.last_http_status = last_http_status_;
  return result;
}

bool Logger::cachedRssiDbm(int32_t* rssi_dbm) const {
  if (!cached_rssi_valid_ || rssi_dbm == nullptr) return false;
  *rssi_dbm = cached_rssi_dbm_;
  return true;
}

void Logger::setLed(LedState state) {
  if (!matrix_ready_ || state == led_state_) return;
  led_state_ = state;
  switch (state) {
    case LedState::Connecting:
      matrix_.loadFrame(kLedConnecting);
      break;
    case LedState::Online:
      matrix_.loadFrame(kLedOnline);
      break;
    case LedState::Uploading:
      matrix_.loadFrame(kLedUploading);
      break;
    case LedState::Buffering:
      matrix_.loadFrame(kLedBuffering);
      break;
    case LedState::Complete:
      matrix_.loadFrame(kLedComplete);
      break;
    case LedState::Error:
      matrix_.loadFrame(kLedError);
      break;
    case LedState::Unknown:
      break;
  }
}

void Logger::setState(State state) {
  state_ = state;
  switch (state) {
    case State::Connecting:
      setLed(LedState::Connecting);
      break;
    case State::Online:
      setLed(core_.journalUsed() > 0 ? LedState::Buffering : LedState::Online);
      break;
    case State::Uploading:
      setLed(LedState::Uploading);
      break;
    case State::Backoff:
      setLed(LedState::Buffering);
      break;
    case State::Complete:
      setLed(LedState::Complete);
      break;
    case State::AuthBlocked:
    case State::Stale:
    case State::Faulted:
      setLed(LedState::Error);
      break;
    case State::Idle:
      break;
  }
}

void Logger::diagnose(const __FlashStringHelper* message) {
  if (config_.diagnostics != nullptr) config_.diagnostics->println(message);
}

}  // namespace uno_r4
}  // namespace alloy

#endif  // defined(ARDUINO_UNOR4_WIFI)
