// AlloyReliability.h — small, platform-neutral policies shared by the ESP32 uploader and tests.

#pragma once

#include <stdint.h>
#include <string.h>

namespace alloy_storage_internal {

// Outside HTTPClient's transport-error range; negative so the logger retains and retries data.
static const int kUploadSessionProtocolError = -1010;
static const int kDataLossStatus = -1005;

// How long the uploader waits for SNTP before taking the server's clock instead. Some networks
// filter or delay NTP for a minute or more; waiting on it would hold every buffer until the pool
// sheds them.
static const uint32_t kSntpGraceMs = 5000;

inline bool parseDigits(const char* p, int count, int* out) {
  int value = 0;
  for (int i = 0; i < count; i++) {
    if (p[i] < '0' || p[i] > '9') return false;
    value = value * 10 + (p[i] - '0');
  }
  *out = value;
  return true;
}

// Parses an HTTP IMF-fixdate ("Wed, 04 Nov 2026 13:06:33 GMT", RFC 9110) to Unix seconds.
// The obsolete RFC 850 and asctime forms are rejected; servers must send the fixed form.
inline bool parseHttpDate(const char* s, uint32_t* epoch) {
  static const char kMonths[] = "JanFebMarAprMayJunJulAugSepOctNovDec";
  if (!s || !epoch || strlen(s) != 29) return false;
  if (s[3] != ',' || s[4] != ' ' || s[7] != ' ' || s[11] != ' ' || s[16] != ' ' ||
      s[19] != ':' || s[22] != ':' || s[25] != ' ' || strcmp(s + 26, "GMT") != 0) return false;
  int day, year, hour, minute, second, month = 0;
  if (!parseDigits(s + 5, 2, &day) || !parseDigits(s + 12, 4, &year) ||
      !parseDigits(s + 17, 2, &hour) || !parseDigits(s + 20, 2, &minute) ||
      !parseDigits(s + 23, 2, &second)) return false;
  for (int m = 0; m < 12; m++)
    if (strncmp(s + 8, kMonths + 3 * m, 3) == 0) month = m + 1;
  static const int kDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  if (month == 0 || year < 1970 || year > 2105 || hour > 23 || minute > 59 || second > 60 ||
      day < 1 || day > kDays[month - 1] + (month == 2 && leap ? 1 : 0)) return false;
  // Days since 1970-01-01 (Hinnant's days_from_civil; years are >= 1970 so all terms are >= 0).
  const int y = year - (month <= 2 ? 1 : 0);
  const int era = y / 400, yoe = y - era * 400;
  const int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const uint32_t days = (uint32_t)(era * 146097 + doe - 719468);
  *epoch = days * 86400u + (uint32_t)(hour * 3600 + minute * 60 + second);
  return true;
}

enum EndGate {
  END_WAITING,
  END_READY,
  END_FAILED,
};

// A graceful boundary is ready only after metadata has left the shared HTTP transport and every
// buffer has returned. Returned buffers are not proof of delivery when one was terminally lost.
inline EndGate endGate(bool metadataSettled, bool metadataDelivered,
                       unsigned freeBuffers, unsigned totalBuffers,
                       int deliveryFailureStatus) {
  if (!metadataSettled || freeBuffers < totalBuffers) return END_WAITING;
  if (!metadataDelivered || deliveryFailureStatus != 0) return END_FAILED;
  return END_READY;
}

inline bool present(const char* value) { return value && value[0] != '\0'; }

// These are the complete fields needed to construct and sign the direct R2 PUT. A 2xx response
// missing any one of them is a protocol failure, not a successful HTTP result.
inline bool uploadSessionComplete(const char* bucket, const char* endpoint,
                                  const char* region, const char* prefix,
                                  const char* accessKey, const char* secretKey,
                                  const char* sessionToken) {
  if (!present(bucket) || !present(endpoint) || !present(region) || !present(prefix) ||
      !present(accessKey) || !present(secretKey) || !present(sessionToken)) return false;
  const char* host = endpoint;
  const size_t endpointLength = strlen(endpoint);
  if (endpointLength > 7 && strncmp(host, "http://", 7) == 0) {
    host += 7;
  } else if (endpointLength > 8 && strncmp(host, "https://", 8) == 0) {
    host += 8;
  } else {
    return false;
  }
  return host[0] != '\0';
}

// An expired temporary R2 credential commonly returns 403. Refresh exactly once; a repeated
// 401/403 after a fresh mint is a real terminal authorization failure.
inline bool shouldRefreshUploadSession(int putStatus, bool refreshAlreadyAttempted) {
  return !refreshAlreadyAttempted && (putStatus == 401 || putStatus == 403);
}

}  // namespace alloy_storage_internal
