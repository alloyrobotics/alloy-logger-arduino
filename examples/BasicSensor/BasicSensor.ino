// BasicSensor — stream a sensor's readings to Alloy in ~10 lines.
//
// Fill in WiFi + your Alloy API key (Dashboard → Mesh Storage → API key), flash, and watch the
// data appear in Alloy Mesh Storage under demos/basic/. No SD card, nothing blocks loop().

#include <AlloyLogger.h>
#include <math.h>

const char* WIFI_SSID = "your-2.4GHz-ssid";
const char* WIFI_PASS = "your-wifi-password";
const char* ALLOY_KEY = "your-alloy-api-key";

AlloyLogger alloy;

void setup() {
  Serial.begin(115200);

  // OPTIONAL — hand Alloy richer context (units/range/description). Skip this and Alloy still
  // reasons from the tag + field names + values. Call before begin().
  alloy.describe("env", "temp_c",   "degC", -40, 125, "ambient temperature");
  alloy.describe("env", "humidity", "%",      0, 100);

  alloy.wifi(WIFI_SSID, WIFI_PASS);          // omit if your sketch already connected WiFi
  if (!alloy.begin(ALLOY_KEY, "demos/basic")) {   // device id defaults to the sketch name
    Serial.println("Alloy begin failed (WiFi?)");
  }
}

void loop() {
  // pretend sensor
  float temp = 22.0 + 3.0 * sin(millis() / 5000.0);
  float hum  = 50.0 + 10.0 * sin(millis() / 8000.0);

  // multi-field record — name sits next to value; commits at the ';'
  alloy.log("env").set("temp_c", temp).set("humidity", hum);

  // single value — shorthand
  alloy.log("battery", 3.7 + 0.1 * sin(millis() / 3000.0));

  delay(50);   // 20 Hz
}
