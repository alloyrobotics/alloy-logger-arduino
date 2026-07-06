// AutoCapture — set-and-forget streaming with NO code in loop().
//
// scope() is the software oscilloscope: one line, and every GPIO your sketch configures streams
// change-driven to Alloy (level + toggle frequency per pin), plus heap/rssi/uptime. Add
// watchAnalog()/watch() for ADC pins and variables. So when something unexpected happens, the
// data is already there: no reflash to add a probe, no serial monitor, no SD card.

#include <AlloyLogger.h>
#include <math.h>

const char* WIFI_SSID = "your-2.4GHz-ssid";
const char* WIFI_PASS = "your-wifi-password";
const char* ALLOY_KEY = "your-alloy-api-key";

AlloyLogger alloy;

// Any variable you want streamed: expose it through a captureless function and watch() it.
float g_pitch = 0;
float readPitch() { return g_pitch; }

void setup() {
  Serial.begin(115200);

  alloy.wifi(WIFI_SSID, WIFI_PASS);          // omit if your sketch already connected WiFi

  pinMode(2, OUTPUT);                        // the blinker below — scope() will find it on its own

  // ---- register once; captured for you forever ----
  alloy.scope();                             // every configured GPIO -> "io", + heap/rssi/uptime -> "sys"
  alloy.watchAnalog(34, "batt_raw");         // ADC on GPIO34        -> channel "adc"
  alloy.watch("imu", "pitch", readPitch);    // any variable/expr    -> channel "imu"
  alloy.sampleEvery(100);                    // 10 Hz (default)

  alloy.begin(ALLOY_KEY, "demos/auto");
}

void loop() {
  // Nothing to log here. Your firmware just runs; the watched signals stream on their own.
  g_pitch = 6.0 * sin(millis() / 600.0);     // pretend an IMU updates this somewhere
  digitalWrite(2, (millis() / 500) & 1);     // 1 Hz blink — shows up as gpio2 rows in "io"
  delay(5);
}
