// AlloyReliability.h — small, platform-neutral policies shared by the ESP32 uploader and tests.

#pragma once

#include <string.h>

namespace alloy_logger_internal {

// Outside HTTPClient's transport-error range; negative so the logger retains and retries data.
static const int kUploadSessionProtocolError = -1010;
static const int kDataLossStatus = -1005;

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

}  // namespace alloy_logger_internal
