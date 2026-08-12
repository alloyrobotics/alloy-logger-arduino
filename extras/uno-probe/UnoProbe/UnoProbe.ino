#include <WiFiS3.h>
#include <WiFiSSLClient.h>
#include <malloc.h>

namespace {

constexpr unsigned long kCredentialTimeoutMs = 30000;
constexpr unsigned long kConnectTimeoutMs = 45000;
constexpr unsigned long kDhcpTimeoutMs = 60000;
constexpr unsigned long kTimeSyncTimeoutMs = 30000;
constexpr unsigned long kTlsConnectTimeoutMs = 8000;
constexpr unsigned long kHttpTimeoutMs = 15000;
constexpr char kProbeHost[] = "alloylogger.com";

char ssid[64];
char password[128];
char startCommand[8];

bool readLine(char* out, size_t capacity, unsigned long timeoutMs) {
  if (capacity == 0) return false;
  size_t used = 0;
  const unsigned long started = millis();
  while (millis() - started < timeoutMs) {
    while (Serial.available()) {
      const int value = Serial.read();
      if (value == '\r') continue;
      if (value == '\n') {
        out[used] = '\0';
        return used > 0;
      }
      if (used + 1 < capacity) out[used++] = static_cast<char>(value);
    }
  }
  out[used] = '\0';
  return false;
}

long freeHeapBytes() {
  const struct mallinfo info = mallinfo();
  return info.fordblks;
}

void finish(const __FlashStringHelper* result) {
  Serial.print(F("RESULT="));
  Serial.println(result);
  Serial.flush();
  WiFi.end();
}

bool isZeroAddress(const IPAddress& address) {
  return address == IPAddress(0, 0, 0, 0);
}

bool isHttpStatusLine(const char* line) {
  if (strncmp(line, "HTTP/1.0 ", 9) != 0 && strncmp(line, "HTTP/1.1 ", 9) != 0) {
    return false;
  }
  return line[9] >= '1' && line[9] <= '5' &&
         line[10] >= '0' && line[10] <= '9' &&
         line[11] >= '0' && line[11] <= '9' && line[12] == ' ';
}

}  // namespace

void setup() {
  Serial.begin(115200);
  const unsigned long serialStarted = millis();
  while (!Serial && millis() - serialStarted < 10000) {}

  Serial.println(F("READY_START"));
  if (!readLine(startCommand, sizeof(startCommand), kCredentialTimeoutMs) ||
      strcmp(startCommand, "START") != 0) {
    finish(F("START_TIMEOUT"));
    return;
  }

  Serial.println(F("ALLOY_UNO_R4_PROBE_V1"));
  const char* firmwareVersion = WiFi.firmwareVersion();
  Serial.print(F("WIFI_FIRMWARE="));
  Serial.println(firmwareVersion);
  Serial.print(F("WIFI_FIRMWARE_EXPECTED="));
  Serial.println(WIFI_FIRMWARE_LATEST_VERSION);
  Serial.print(F("HEAP_BASELINE_BYTES="));
  Serial.println(freeHeapBytes());

  if (WiFi.status() == WL_NO_MODULE) {
    finish(F("WIFI_MODULE_MISSING"));
    return;
  }
  if (strcmp(firmwareVersion, WIFI_FIRMWARE_LATEST_VERSION) != 0) {
    finish(F("WIFI_FIRMWARE_MISMATCH"));
    return;
  }

  Serial.println(F("READY_SSID"));
  if (!readLine(ssid, sizeof(ssid), kCredentialTimeoutMs)) {
    finish(F("SSID_TIMEOUT"));
    return;
  }
  Serial.println(F("READY_PASSWORD"));
  if (!readLine(password, sizeof(password), kCredentialTimeoutMs)) {
    finish(F("PASSWORD_TIMEOUT"));
    return;
  }

  // Reset any static IP or socket state left by an earlier diagnostic so this
  // run proves that the network itself supplies DHCP and DNS.
  WiFi.end();
  delay(500);
  WiFi.setTimeout(kConnectTimeoutMs);
  Serial.println(F("WIFI_CONNECTING"));
  const unsigned long wifiStarted = millis();
  const int status = WiFi.begin(ssid, password);
  memset(password, 0, sizeof(password));

  if (status != WL_CONNECTED) {
    Serial.print(F("WIFI_STATUS="));
    Serial.println(status);
    finish(F("WIFI_ASSOCIATION_FAILED"));
    return;
  }

  Serial.print(F("WIFI_CONNECTED_MS="));
  Serial.println(millis() - wifiStarted);
  const unsigned long dhcpStarted = millis();
  IPAddress ip = WiFi.localIP();
  while (isZeroAddress(ip) && millis() - dhcpStarted < kDhcpTimeoutMs) {
    delay(500);
    ip = WiFi.localIP();
  }
  const IPAddress gateway = WiFi.gatewayIP();
  const IPAddress subnet = WiFi.subnetMask();
  const IPAddress dns = WiFi.dnsIP();
  Serial.print(F("DHCP_READY_MS="));
  Serial.println(millis() - dhcpStarted);
  Serial.print(F("WIFI_RSSI_DBM="));
  Serial.println(WiFi.RSSI());
  Serial.print(F("WIFI_IP="));
  Serial.println(ip);
  Serial.print(F("WIFI_GATEWAY="));
  Serial.println(gateway);
  Serial.print(F("WIFI_SUBNET="));
  Serial.println(subnet);
  Serial.print(F("WIFI_DNS="));
  Serial.println(dns);

  if (isZeroAddress(ip)) {
    Serial.print(F("WIFI_STATUS="));
    Serial.println(WiFi.status());
    finish(F("DHCP_TIMEOUT"));
    return;
  }
  if (isZeroAddress(gateway) || isZeroAddress(subnet)) {
    finish(F("DHCP_CONFIG_INVALID"));
    return;
  }
  if (isZeroAddress(dns)) {
    finish(F("DNS_SERVER_MISSING"));
    return;
  }

  IPAddress resolved;
  const int dnsResult = WiFi.hostByName(kProbeHost, resolved);
  Serial.print(F("DNS_RESULT="));
  Serial.println(dnsResult);
  Serial.print(F("DNS_IP="));
  Serial.println(resolved);
  if (dnsResult != 1 || isZeroAddress(resolved)) {
    finish(F("DNS_FAILED"));
    return;
  }

  const unsigned long timeStarted = millis();
  unsigned long epoch = WiFi.getTime();
  while (epoch == 0 && millis() - timeStarted < kTimeSyncTimeoutMs) {
    delay(500);
    epoch = WiFi.getTime();
  }
  Serial.print(F("TIME_SYNC_MS="));
  Serial.println(millis() - timeStarted);
  Serial.print(F("TIME_EPOCH="));
  Serial.println(epoch);
  if (epoch == 0) {
    // UDP NTP is commonly blocked on otherwise usable guest/corporate Wi-Fi.
    // Keep proving verified HTTPS; the real adapter can derive an explicitly
    // approximate UTC anchor from its authenticated server response instead.
    Serial.println(F("TIME_SYNC_UNAVAILABLE=1"));
  }

  const long heapBeforeTls = freeHeapBytes();
  Serial.print(F("HEAP_BEFORE_TLS_BYTES="));
  Serial.println(heapBeforeTls);

  WiFiSSLClient client;
  client.setConnectionTimeout(kTlsConnectTimeoutMs);
  const unsigned long tlsStarted = millis();
  if (!client.connect(kProbeHost, 443)) {
    Serial.print(F("TLS_CONNECT_MS="));
    Serial.println(millis() - tlsStarted);
    Serial.print(F("HEAP_AFTER_TLS_FAILURE_BYTES="));
    Serial.println(freeHeapBytes());
    finish(F("TLS_CONNECT_FAILED"));
    return;
  }

  Serial.print(F("TLS_CONNECT_MS="));
  Serial.println(millis() - tlsStarted);
  Serial.print(F("HEAP_AFTER_TLS_CONNECT_BYTES="));
  Serial.println(freeHeapBytes());
  client.print(F("HEAD / HTTP/1.1\r\nHost: "));
  client.print(kProbeHost);
  client.print(F("\r\nConnection: close\r\n\r\n"));

  const unsigned long httpStarted = millis();
  char statusLine[96] = {};
  size_t statusUsed = 0;
  while (millis() - httpStarted < kHttpTimeoutMs && statusUsed + 1 < sizeof(statusLine)) {
    if (client.available()) {
      const int value = client.read();
      if (value == '\r') continue;
      if (value == '\n') break;
      statusLine[statusUsed++] = static_cast<char>(value);
    } else if (!client.connected()) {
      break;
    }
  }
  statusLine[statusUsed] = '\0';
  Serial.print(F("HTTP_STATUS_LINE="));
  Serial.println(statusLine);
  Serial.print(F("HTTP_FIRST_BYTE_MS="));
  Serial.println(millis() - httpStarted);
  client.stop();
  Serial.print(F("HEAP_AFTER_TLS_STOP_BYTES="));
  Serial.println(freeHeapBytes());

  if (isHttpStatusLine(statusLine)) {
    finish(F("PASS"));
  } else {
    finish(F("HTTP_RESPONSE_INVALID"));
  }
}

void loop() {}
