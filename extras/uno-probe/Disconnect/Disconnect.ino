#include <WiFiS3.h>

void setup() {
  WiFi.end();
  Serial.begin(115200);
  const unsigned long started = millis();
  while (!Serial && millis() - started < 3000) {}
  Serial.println("ALLOY_UNO_WIFI_DISCONNECTED");
}

void loop() {
  delay(1000);
  Serial.println("ALLOY_UNO_WIFI_DISCONNECTED");
}
