#pragma once

#if !defined(ARDUINO_UNOR4_WIFI)
#error "AlloyUnoR4 requires an Arduino UNO R4 WiFi board"
#endif

#include <Arduino.h>
#include <Arduino_LED_Matrix.h>
#include <WiFiS3.h>
#include <WiFiSSLClient.h>

#include "alloy/device/core.h"
#include "alloy/uno_r4/UnoR4Platform.h"

namespace alloy {
namespace uno_r4 {

enum class BeginResult : uint8_t {
  Started = 0,
  InvalidConfig,
  EntropyInitFailed,
  EntropyReadFailed,
  EntropyAllZero,
  CoreRejected,
  Faulted,
};

enum class CommitResult : uint8_t {
  Accepted = 0,
  WouldBlock,
  Invalid,
  Faulted,
};

enum class State : uint8_t {
  Idle = 0,
  Connecting,
  Online,
  Uploading,
  Backoff,
  AuthBlocked,
  Stale,
  Complete,
  Faulted,
};

// Every pointer is borrowed. The pointed-to strings, including credentials
// and an optional CA, must remain valid and unchanged while the logger is
// polled.
struct Config {
  Config();

  const char* ssid;
  const char* password;
  const char* api_key;
  const char* device_id;
  const char* mesh_path;
  const char* firmware;
  const char* mission;
  const char* host;
  const char* ca_cert;  // Null for default roots; otherwise a bounded PEM envelope.
  const char* request_path;
  uint16_t port;
  uint32_t finalize_after_ms;
  uint32_t wifi_connect_timeout_ms;
  uint32_t dhcp_timeout_ms;
  uint32_t tls_connect_timeout_ms;
  uint32_t response_timeout_ms;
  Print* diagnostics;
  bool use_led_matrix;
};

struct Field {
  uint8_t id;
  device::v1::FieldType type;
  const char* name;
  const char* unit;
};

struct Stats {
  uint32_t attempted_samples;
  uint32_t encoded_samples;
  uint32_t dropped_samples;
  uint32_t dropped_frames;
  uint32_t corrupt_frames;
  uint32_t backpressure_events;
  uint32_t retry_attempts;
  uint32_t acknowledged_frames;
  uint32_t wifi_connect_attempts;
  uint32_t transport_failures;
  uint16_t journal_used;
  int32_t cached_rssi_dbm;
  bool cached_rssi_valid;
  uint16_t last_http_status;
};

class Logger;

class Sample {
 public:
  Sample(Sample&& other);
  ~Sample();  // Intentionally does not commit.

  Sample& setBool(uint8_t field_id, bool value);
  Sample& setI8(uint8_t field_id, int8_t value);
  Sample& setU8(uint8_t field_id, uint8_t value);
  Sample& setI16(uint8_t field_id, int16_t value);
  Sample& setU16(uint8_t field_id, uint16_t value);
  Sample& setI32(uint8_t field_id, int32_t value);
  Sample& setU32(uint8_t field_id, uint32_t value);
  Sample& setF32(uint8_t field_id, float value);
  Sample& setF64(uint8_t field_id, double value);

  CommitResult commit();
  bool valid() const;

 private:
  friend class Logger;

  Sample(Logger* logger, uint16_t schema_id, uint16_t revision,
         uint16_t anchor_id, uint32_t raw_micros, uint8_t field_count,
         const uint8_t* field_types);
  Sample(const Sample&);
  Sample& operator=(const Sample&);
  Sample& setValue(uint8_t field_id, device::v1::FieldType type,
                   const device::v1::SampleValue& value);

  Logger* logger_;
  uint16_t schema_id_;
  uint16_t revision_;
  uint16_t anchor_id_;
  uint32_t raw_micros_;
  uint8_t field_count_;
  uint8_t field_types_[device::v1::kMaxFieldsPerSchema];
  device::v1::SampleFieldValue fields_[device::v1::kMaxFieldsPerSchema];
  bool invalid_;
  bool committed_;
};

class Logger {
 public:
  Logger();

  BeginResult begin(const Config& config);
  CommitResult declareSchema(uint16_t schema_id, uint16_t revision,
                             const char* channel, const Field* fields,
                             uint8_t field_count);
  Sample sample(uint16_t schema_id, uint16_t revision);
  CommitResult end();
  void poll();

  State state() const;
  Stats stats() const;
  bool cachedRssiDbm(int32_t* rssi_dbm) const;

 private:
  friend class Sample;

  struct SchemaCache {
    bool used;
    uint16_t schema_id;
    uint16_t revision;
    uint8_t field_count;
    uint8_t field_types[device::v1::kMaxFieldsPerSchema];
  };

  enum class LedState : uint8_t {
    Unknown = 0,
    Connecting,
    Online,
    Uploading,
    Buffering,
    Complete,
    Error,
  };

  enum class ResponsePhase : uint8_t {
    Idle = 0,
    Headers,
    Body,
    Complete,
    Invalid,
  };

  CommitResult commitSample(uint32_t raw_micros, uint16_t schema_id,
                            uint16_t revision, uint16_t anchor_id,
                            uint8_t field_count,
                            const device::v1::SampleFieldValue* fields);
  const SchemaCache* findSchema(uint16_t schema_id, uint16_t revision) const;
  bool validateConfig(const Config& config) const;
  bool serviceWifi(uint32_t now_ms);
  void serviceNetwork(uint32_t now_ms);
  bool startRequest();
  void serviceResponse(uint32_t now_ms);
  void finishResponse(uint64_t received_mono_us);
  void transportFailure(uint32_t now_ms, bool request_was_sent);
  void scheduleWifiRetry(uint32_t now_ms);
  void scheduleUploadRetry(uint32_t now_ms, uint32_t requested_ms);
  void resetResponse();
  void consumeResponseByte(uint8_t byte);
  void parseResponseLine();
  void serviceClockAnchors(uint32_t now_ms);
  bool queueAnchor(device::v1::AnchorSource source,
                   device::v1::AnchorQuality quality, uint64_t mono_us,
                   uint64_t utc_ns, uint32_t uncertainty_us);
  bool refreshMonotonic(uint64_t* mono_us);
  void serviceRssi(uint32_t now_ms);
  void setLed(LedState state);
  void setState(State state);
  void diagnose(const __FlashStringHelper* message);

  static bool due(uint32_t now_ms, uint32_t deadline_ms);
  static uint32_t boundedBackoff(uint8_t exponent);
  static uint8_t boundedLength(const char* text, uint8_t maximum,
                               bool* valid);
  static bool headerValueSafe(const char* text, bool allow_empty);
  static bool writeText(WiFiSSLClient& client, const char* text);
  static bool writeUnsigned(WiFiSSLClient& client, uint32_t value);

  Config config_;
  device::v1::FixedJournal journal_;
  device::v1::Core core_;
  detail::TlsClient client_;
  ArduinoLEDMatrix matrix_;
  SchemaCache schemas_[device::v1::kCoreMaxSchemas];
  device::v1::FrameView in_flight_;
  State state_;
  LedState led_state_;
  ResponsePhase response_phase_;
  char run_id_hex_[33];
  char response_line_[320];
  uint8_t response_body_[device::v1::kAckBytes];
  uint16_t response_line_size_;
  uint16_t response_body_size_;
  uint16_t response_header_bytes_;
  uint16_t response_status_;
  uint16_t response_content_length_;
  uint32_t response_deadline_ms_;
  uint64_t response_server_utc_ns_;
  uint64_t request_sent_mono_us_;
  uint32_t next_wifi_attempt_ms_;
  uint32_t dhcp_deadline_ms_;
  uint32_t next_upload_attempt_ms_;
  uint32_t next_rssi_ms_;
  uint32_t next_sntp_ms_;
  uint32_t next_wifi_status_ms_;
  uint32_t last_sample_commit_ms_;
  uint32_t acknowledged_frames_;
  uint32_t wifi_connect_attempts_;
  uint32_t transport_failures_;
  uint32_t last_reported_drops_;
  int32_t cached_rssi_dbm_;
  uint16_t active_anchor_id_;
  uint16_t next_anchor_id_;
  uint8_t wifi_backoff_exponent_;
  uint8_t upload_backoff_exponent_;
  uint8_t frame_send_count_;
  bool started_;
  bool wifi_ready_;
  bool dhcp_waiting_;
  bool frame_active_;
  bool response_content_length_seen_;
  bool response_content_type_seen_;
  bool response_server_utc_seen_;
  bool response_line_truncated_;
  bool response_first_line_;
  bool matrix_ready_;
  bool cached_rssi_valid_;
  bool have_any_anchor_;
  bool have_sntp_anchor_;
  uint16_t last_http_status_;
};

}  // namespace uno_r4
}  // namespace alloy

using AlloyUnoR4 = alloy::uno_r4::Logger;
using AlloyUnoR4BeginResult = alloy::uno_r4::BeginResult;
using AlloyUnoR4CommitResult = alloy::uno_r4::CommitResult;
using AlloyUnoR4Config = alloy::uno_r4::Config;
using AlloyUnoR4Field = alloy::uno_r4::Field;
using AlloyUnoR4Sample = alloy::uno_r4::Sample;
using AlloyUnoR4State = alloy::uno_r4::State;
using AlloyUnoR4Stats = alloy::uno_r4::Stats;
