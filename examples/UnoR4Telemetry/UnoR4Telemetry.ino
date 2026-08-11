#include <AlloyUnoR4.h>

#include "arduino_secrets.h"

namespace {

AlloyUnoR4 logger;
const uint8_t kButtonPin = 2;
const uint16_t kTelemetrySchema = 1;
const uint16_t kTelemetryRevision = 1;
uint32_t sampleCounter = 0;
uint32_t nextSampleMs = 0;
uint32_t nextReportMs = 0;

const AlloyUnoR4Field kTelemetryFields[] = {
    {0, alloy::device::v1::FIELD_U16, "pot_raw", "count"},
    {1, alloy::device::v1::FIELD_BOOL, "button_high", ""},
    {2, alloy::device::v1::FIELD_U32, "uptime_ms", "ms"},
    {3, alloy::device::v1::FIELD_I32, "wifi_rssi", "dBm"},
    {4, alloy::device::v1::FIELD_U8, "logger_state", ""},
    {5, alloy::device::v1::FIELD_U32, "scheduled_tick", "count"},
};

}  // namespace

void setup() {
  Serial.begin(115200);
  const uint32_t serialStarted = millis();
  while (!Serial && millis() - serialStarted < 5000) {}

  pinMode(kButtonPin, INPUT_PULLUP);

  AlloyUnoR4Config config;
  config.ssid = SECRET_WIFI_SSID;
  config.password = SECRET_WIFI_PASSWORD;
  config.api_key = SECRET_ALLOY_API_KEY;
  config.device_id = "uno-r4-01";
  config.mesh_path = "arduino/uno-r4";
  config.firmware = "uno-r4-telemetry-v1";
  config.mission = "bench-telemetry";
  config.diagnostics = &Serial;

  if (logger.begin(config) != AlloyUnoR4BeginResult::Started) {
    Serial.println(F("Alloy begin failed; check non-placeholder credentials."));
    return;
  }
  if (logger.declareSchema(kTelemetrySchema, kTelemetryRevision, "board_io",
                           kTelemetryFields,
                           sizeof(kTelemetryFields) /
                               sizeof(kTelemetryFields[0])) !=
      AlloyUnoR4CommitResult::Accepted) {
    Serial.println(F("Alloy schema declaration failed."));
  }
  nextSampleMs = millis();
  nextReportMs = nextSampleMs + 5000;
}

void loop() {
  logger.poll();

  const uint32_t now = millis();
  if (static_cast<int32_t>(now - nextSampleMs) >= 0) {
    const uint32_t elapsedTicks = (now - nextSampleMs) / 100 + 1;
    sampleCounter += elapsedTicks;
    nextSampleMs += elapsedTicks * 100;
    // Perform board I/O before entering Alloy's deterministic capture path.
    const uint16_t potRaw = static_cast<uint16_t>(analogRead(A0));
    const bool buttonHigh = digitalRead(kButtonPin) != LOW;
    AlloyUnoR4Sample row = logger.sample(kTelemetrySchema, kTelemetryRevision);
    row.setU16(0, potRaw)
        .setBool(1, buttonHigh)
        .setU32(2, now)
        .setU8(4, static_cast<uint8_t>(logger.state()))
        .setU32(5, sampleCounter);
    int32_t rssiDbm = 0;
    if (logger.cachedRssiDbm(&rssiDbm)) row.setI32(3, rssiDbm);
    row.commit();
  }

  if (static_cast<int32_t>(now - nextReportMs) >= 0) {
    nextReportMs = now + 5000;
    const AlloyUnoR4Stats stats = logger.stats();
    Serial.print(F("state="));
    Serial.print(static_cast<unsigned int>(logger.state()));
    Serial.print(F(" journal="));
    Serial.print(stats.journal_used);
    Serial.print(F(" acked="));
    Serial.print(stats.acknowledged_frames);
    Serial.print(F(" dropped="));
    Serial.println(stats.dropped_samples);
  }
}
