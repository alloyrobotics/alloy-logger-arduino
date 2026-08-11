#include <AlloyUnoR4.h>

#include "arduino_secrets.h"

namespace {

AlloyUnoR4 logger;
const AlloyUnoR4Field kFields[] = {
    {0, alloy::device::v1::FIELD_U32, "uptime_ms", "ms"},
};
uint32_t nextSampleMs = 0;
uint16_t samplesAttempted = 0;
bool endQueued = false;
bool completeReported = false;

}  // namespace

void setup() {
  Serial.begin(115200);
  const uint32_t serialStarted = millis();
  while (!Serial && millis() - serialStarted < 5000) {}

  AlloyUnoR4Config config;
  config.ssid = SECRET_WIFI_SSID;
  config.password = SECRET_WIFI_PASSWORD;
  config.api_key = SECRET_ALLOY_API_KEY;
  config.device_id = "uno-r4-starter";
  config.mesh_path = "arduino/uno-r4";
  config.firmware = "starter-v1";
  config.mission = "finite-starter";
  config.diagnostics = &Serial;

  if (logger.begin(config) != AlloyUnoR4BeginResult::Started ||
      logger.declareSchema(1, 1, "uptime", kFields, 1) !=
          AlloyUnoR4CommitResult::Accepted) {
    Serial.println(F("Alloy setup failed; check non-placeholder credentials."));
    return;
  }
  nextSampleMs = millis();
}

void loop() {
  logger.poll();

  const uint32_t now = millis();
  if (samplesAttempted < 100 &&
      static_cast<int32_t>(now - nextSampleMs) >= 0) {
    nextSampleMs = now + 100;
    ++samplesAttempted;
    logger.sample(1, 1).setU32(0, now).commit();
  }

  // end() is cooperative: a full journal returns WouldBlock, so retry it
  // after poll() drains space. No destructor or hidden timeout ends the run.
  if (samplesAttempted == 100 && !endQueued &&
      logger.end() == AlloyUnoR4CommitResult::Accepted) {
    endQueued = true;
    Serial.println(F("RUN_END queued; waiting for its exact ACK."));
  }

  if (endQueued && !completeReported &&
      logger.state() == AlloyUnoR4State::Complete) {
    completeReported = true;
    Serial.println(F("RUN_END acknowledged. Cloud finalization is asynchronous."));
  }
}
