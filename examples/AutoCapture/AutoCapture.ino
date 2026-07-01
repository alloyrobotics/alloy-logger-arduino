// AutoCapture — set-and-forget streaming with NO code in loop().
//
// This is the v2 idea: register the signals you care about ONCE, and AlloyLogger samples them for
// you on a timer in the background. Digital pins, analog pins, system health, or any variable —
// all streamed to Alloy automatically. So when something unexpected happens, the data is already
// there: no reflash to add a probe, no serial monitor, no SD card.

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
  alloy.device("bench-01", "v2");

  // ---- register once; sampled for you forever ----
  alloy.watch(0, "boot_btn");                // GPIO0 digital state  -> channel "io"
  alloy.watchAnalog(34, "batt_raw");         // ADC on GPIO34        -> channel "adc"
  alloy.watch("imu", "pitch", readPitch);    // any variable/expr    -> channel "imu"
  alloy.watchSystem();                        // heap / rssi / uptime -> channel "sys"
  alloy.sampleEvery(100);                    // 10 Hz (default)

  alloy.begin(ALLOY_KEY, "demos/auto");
}

void loop() {
  // Nothing to log here. Your firmware just runs; the watched signals stream on their own.
  g_pitch = 6.0 * sin(millis() / 600.0);     // pretend an IMU updates this somewhere
  delay(5);
}
