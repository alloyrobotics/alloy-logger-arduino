// FirstMission — the shortest path from a fresh ESP32 to a confirmed Alloy mission.
//
// Change the four settings below, flash, then open Serial Monitor at 115200 baud. This sketch
// records generated telemetry for 20 seconds, prints upload health as it runs, and explicitly
// finalizes the mission. No sensors are required.

#include <AlloyLogger.h>
#include <WiFi.h>
#include <math.h>

// --------------------------- CHANGE THESE ---------------------------------
const char* WIFI_SSID       = "YOUR_2_4_GHZ_WIFI_NAME";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";
const char* ALLOY_API_KEY   = "YOUR_ALLOY_DATA_API_KEY";
const char* ALLOY_MESH_PATH = "first-missions/esp32";  // letters, numbers, _, -, and / only
// --------------------------------------------------------------------------

// Current limitation: this is a long-lived, org-wide data API key, not a write-only key scoped
// to ALLOY_MESH_PATH. Do not commit the real value; rotate it if this sketch is ever shared.

constexpr uint32_t MISSION_SECONDS = 20;
AlloyLogger alloy;

bool unchanged(const char* value, const char* placeholder) {
  return !value || !value[0] || strcmp(value, placeholder) == 0;
}

bool validMeshPath(const char* path) {
  if (!path) return false;
  size_t len = strlen(path);
  if (len == 0 || len > 128 || path[0] == '/' || path[len - 1] == '/') return false;
  for (size_t i = 0; i < len; i++) {
    char c = path[i];
    bool allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                   (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '/';
    if (!allowed) return false;
  }
  return true;
}

void stopWithMessage(const char* message) {
  Serial.println();
  Serial.print("STOP: ");
  Serial.println(message);
  Serial.println("Fix the setting at the top of FirstMission.ino, then flash again.");
  while (true) delay(1000);
}

void printHealth(uint32_t samples, uint32_t elapsedSeconds) {
  String error = alloy.lastError();
  const char* state = WiFi.status() != WL_CONNECTED ? "wifi-lost" :
                      !alloy.ready() ? "syncing-clock" :
                      error.length() ? "delivery-error" : "uploading";
  Serial.printf(
    "[progress] %lus / %lus | state=%s | samples=%lu delivered=%lu queued=%lu "
    "failed=%lu retried=%lu dropped=%lu dropped_rows=%lu stale=%lu",
    (unsigned long)elapsedSeconds,
    (unsigned long)MISSION_SECONDS,
    state,
    (unsigned long)samples,
    (unsigned long)alloy.delivered(),
    (unsigned long)alloy.queued(),
    (unsigned long)alloy.failed(),
    (unsigned long)alloy.retried(),
    (unsigned long)alloy.dropped(),
    (unsigned long)alloy.droppedRows(),
    (unsigned long)alloy.stale()
  );
  if (error.length()) {
    Serial.printf(" last_status=%d error=\"%s\"", alloy.lastStatus(), error.c_str());
  }
  if (WiFi.status() == WL_CONNECTED) Serial.printf(" rssi=%d_dBm", WiFi.RSSI());
  Serial.println();
}

void printRecoveryGuidance(bool finalized) {
  if (!finalized)
    Serial.println("- Finalization was not acknowledged. Retryable data stays queued; terminal loss is shown by the counters/status below.");
  if (WiFi.status() != WL_CONNECTED)
    Serial.println("- Wi-Fi was lost. Move closer to the access point or restore the network.");
  if (!alloy.ready())
    Serial.println("- Clock sync never completed. This network may block NTP; retry on another network or phone hotspot.");

  int status = alloy.lastStatus();
  String error = alloy.lastError();
  if (status == 400 || status == 413) {
    Serial.println("- A setting or payload was rejected. Re-check the mesh path and retry this example unchanged.");
  } else if (status == 401 || status == 403) {
    Serial.println("- The Alloy data API key was rejected. Copy a fresh key and reflash.");
  } else if (status == 409) {
    Serial.println("- This run had already finalized. Reset the ESP32 to start a fresh mission.");
  } else if (status == 429 || status >= 500) {
    Serial.println("- AlloyLogger Cloud is temporarily unavailable. The retained buffer will keep retrying.");
  } else if (status < 0 && error.length()) {
    Serial.println("- HTTPS could not complete. Restore Wi-Fi or try another network while the board stays powered.");
  }

  if (alloy.delivered() == 0 && !error.length() && alloy.ready() && WiFi.status() == WL_CONNECTED)
    Serial.println("- No chunk finished uploading in this run. Keep the board online and inspect the next progress line.");
  if (alloy.dropped() > 0 || alloy.droppedRows() > 0)
    Serial.println("- Data was dropped before delivery. Retry the low-rate example unchanged on stronger Wi-Fi.");
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=== AlloyLogger first mission ===");

  if (unchanged(WIFI_SSID, "YOUR_2_4_GHZ_WIFI_NAME"))
    stopWithMessage("WIFI_SSID is still the placeholder.");
  if (unchanged(WIFI_PASSWORD, "YOUR_WIFI_PASSWORD"))
    stopWithMessage("WIFI_PASSWORD is still the placeholder.");
  if (unchanged(ALLOY_API_KEY, "YOUR_ALLOY_DATA_API_KEY"))
    stopWithMessage("ALLOY_API_KEY is still the placeholder.");
  if (!validMeshPath(ALLOY_MESH_PATH))
    stopWithMessage("ALLOY_MESH_PATH must be 1-128 characters using only letters, numbers, _, -, and / (no edge slash).");

  Serial.printf("[1/4] Connecting to 2.4 GHz Wi-Fi: %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t wifiStarted = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStarted < 20000) {
    Serial.print('.');
    delay(500);
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED)
    stopWithMessage("Wi-Fi did not connect in 20 seconds. Check the SSID, password, and 2.4 GHz network.");
  Serial.printf("      Connected: %s | RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  Serial.printf("[2/4] Starting AlloyLogger | mesh path: %s\n", ALLOY_MESH_PATH);
  alloy.device("esp32-first-mission", "first-mission-v1")
       .mission("first ESP32 mission")
       .finalizeAfter(30);
  alloy.describe("sample", "wave", "", -1, 1, "generated sine wave");
  alloy.describe("sample", "uptime_s", "s", 0, MISSION_SECONDS, "seconds since mission start");
  if (!alloy.begin(ALLOY_API_KEY, ALLOY_MESH_PATH)) {
    String error = alloy.lastError();
    if (error.length()) {
      Serial.print("      ");
      Serial.println(error);
    }
    stopWithMessage("AlloyLogger could not start.");
  }

  Serial.printf("[3/4] Recording generated data for %lu seconds...\n", (unsigned long)MISSION_SECONDS);
  uint32_t missionStarted = millis();
  uint32_t lastProgress = 0;
  uint32_t samples = 0;
  while (millis() - missionStarted < MISSION_SECONDS * 1000UL) {
    float elapsed = (millis() - missionStarted) / 1000.0f;
    alloy.log("sample")
         .set("wave", sinf(elapsed * 2.0f))
         .set("uptime_s", elapsed);
    samples++;

    uint32_t elapsedSeconds = (millis() - missionStarted) / 1000UL;
    if (elapsedSeconds >= lastProgress + 2) {
      lastProgress = elapsedSeconds;
      printHealth(samples, elapsedSeconds);
    }
    delay(50);
  }

  Serial.println("[4/4] Draining uploads and finalizing the mission...");
  bool finalized = alloy.end(15000);
  printHealth(samples, MISSION_SECONDS);

  bool healthy = finalized && alloy.delivered() > 0 && alloy.failed() == 0 &&
                 alloy.dropped() == 0 && alloy.droppedRows() == 0 && alloy.stale() == 0 &&
                 alloy.lastError().length() == 0;
  Serial.println();
  if (healthy) {
    Serial.println("PASS: Alloy accepted the data and acknowledged mission finalization.");
    Serial.printf("Open Alloy > Mesh Storage and browse to %s for the new .mcap mission.\n", ALLOY_MESH_PATH);
  } else {
    Serial.println("CHECK NEEDED: the first mission was not fully confirmed from this ESP32.");
    printRecoveryGuidance(finalized);
  }
}

void loop() {
  delay(1000);  // Mission complete. Reset the ESP32 to run another one.
}
