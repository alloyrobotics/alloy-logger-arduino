#pragma once

#include <stdint.h>

#if defined(ARDUINO_UNOR4_WIFI)

#include <WiFiSSLClient.h>

namespace alloy {
namespace uno_r4 {
namespace detail {

enum class RunIdResult : uint8_t {
  Ok = 0,
  InitFailed,
  ReadFailed,
  AllZero,
};

RunIdResult generateRunId(uint8_t out[16]);

// WiFiS3 0.6.0's custom-root bridge forwards a length-delimited PEM envelope
// to a TLS API that expects a C string. This client includes the terminating
// NUL in that one AT passthrough. A null root keeps WiFiSSLClient's stock
// default trust-bundle path.
class TlsClient : public WiFiSSLClient {
 public:
  TlsClient();

  bool setCustomCa(const char* ca_cert);
  int connect(const char* host, uint16_t port) override;

 private:
  const char* custom_ca_;
  uint16_t custom_ca_bytes_;
};

bool validCustomCaEnvelope(const char* ca_cert);

}  // namespace detail
}  // namespace uno_r4
}  // namespace alloy

#endif  // defined(ARDUINO_UNOR4_WIFI)
