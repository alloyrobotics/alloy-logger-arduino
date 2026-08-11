#if defined(ARDUINO_UNOR4_WIFI)

#include "UnoR4Platform.h"

#include <Arduino.h>

#include <stdlib.h>
#include <string.h>

extern "C" {
#include "common_data.h"

fsp_err_t HW_SCE_McuSpecificInit(void);
fsp_err_t HW_SCE_RNG_Read(uint32_t* out_data);
}

namespace alloy {
namespace uno_r4 {
namespace detail {

namespace {

static const uint16_t kMaximumCustomCaBytes = 4095;
static const char kPemBegin[] = "-----BEGIN CERTIFICATE-----";
static const char kPemEnd[] = "-----END CERTIFICATE-----";

bool measureCustomCaEnvelope(const char* ca_cert, uint16_t* ca_bytes) {
  if (ca_cert == nullptr || ca_bytes == nullptr) return false;

  uint16_t length = 0;
  while (length < kMaximumCustomCaBytes && ca_cert[length] != '\0') {
    ++length;
  }
  if (length == 0 || ca_cert[length] != '\0' ||
      length < sizeof(kPemBegin) - 1 + sizeof(kPemEnd) - 1 ||
      memcmp(ca_cert, kPemBegin, sizeof(kPemBegin) - 1) != 0) {
    return false;
  }

  uint16_t tail = length;
  while (tail > 0) {
    const char value = ca_cert[tail - 1];
    if (value != '\r' && value != '\n' && value != ' ' && value != '\t') {
      break;
    }
    --tail;
  }
  if (tail < sizeof(kPemEnd) - 1 ||
      memcmp(ca_cert + tail - (sizeof(kPemEnd) - 1), kPemEnd,
             sizeof(kPemEnd) - 1) != 0) {
    return false;
  }

  *ca_bytes = length;
  return true;
}

}  // namespace

TlsClient::TlsClient() : custom_ca_(nullptr), custom_ca_bytes_(0) {}

bool TlsClient::setCustomCa(const char* ca_cert) {
  if (ca_cert == nullptr) {
    custom_ca_ = nullptr;
    custom_ca_bytes_ = 0;
    return true;
  }

  uint16_t ca_bytes = 0;
  if (!measureCustomCaEnvelope(ca_cert, &ca_bytes)) {
    custom_ca_ = nullptr;
    custom_ca_bytes_ = 0;
    return false;
  }
  custom_ca_ = ca_cert;
  custom_ca_bytes_ = ca_bytes;
  return true;
}

int TlsClient::connect(const char* host, uint16_t port) {
  if (custom_ca_ == nullptr) {
    return WiFiSSLClient::connect(host, port);
  }

  uint16_t ca_bytes = 0;
  if (host == nullptr || host[0] == '\0' || port == 0 ||
      !measureCustomCaEnvelope(custom_ca_, &ca_bytes) ||
      ca_bytes != custom_ca_bytes_) {
    stop();
    return 0;
  }

  if (_sock >= 0 && !connected()) stop();
  if (_sock == -1) {
    std::string response;
    modem.begin();
    if (modem.write(std::string(PROMPT(_SSLBEGINCLIENT)), response, "%s",
                    CMD(_SSLBEGINCLIENT))) {
      _sock = atoi(response.c_str());
    }
  }
  if (_sock < 0) return 0;

  std::string response;
  const uint16_t wire_bytes = static_cast<uint16_t>(ca_bytes + 1);
  modem.write_nowait(std::string(PROMPT(_SETCAROOT)), response,
                     "%s%d,%d\r\n", CMD_WRITE(_SETCAROOT), _sock,
                     static_cast<int>(wire_bytes));
  if (!modem.passthrough(
          reinterpret_cast<const uint8_t*>(custom_ca_), wire_bytes)) {
    stop();
    return 0;
  }

  const bool connected_ok =
      _connectionTimeout != 0
          ? modem.write(std::string(PROMPT(_SSLCLIENTCONNECT)), response,
                        "%s%d,%s,%d,%d\r\n", CMD_WRITE(_SSLCLIENTCONNECT),
                        _sock, host, port, _connectionTimeout)
          : modem.write(std::string(PROMPT(_SSLCLIENTCONNECTNAME)), response,
                        "%s%d,%s,%d\r\n",
                        CMD_WRITE(_SSLCLIENTCONNECTNAME), _sock, host, port);
  if (!connected_ok) stop();
  return connected_ok ? 1 : 0;
}

bool validCustomCaEnvelope(const char* ca_cert) {
  if (ca_cert == nullptr) return true;
  uint16_t ca_bytes = 0;
  return measureCustomCaEnvelope(ca_cert, &ca_bytes);
}

RunIdResult generateRunId(uint8_t out[16]) {
  static bool initialized = false;
  if (!initialized) {
    if (HW_SCE_McuSpecificInit() != FSP_SUCCESS) {
      return RunIdResult::InitFailed;
    }
    initialized = true;
  }

  uint32_t words[4] = {};
  if (HW_SCE_RNG_Read(words) != FSP_SUCCESS) {
    return RunIdResult::ReadFailed;
  }

  uint32_t any = 0;
  for (uint8_t index = 0; index < 4; ++index) {
    any |= words[index];
    const uint32_t word = words[index];
    out[index * 4 + 0] = static_cast<uint8_t>(word);
    out[index * 4 + 1] = static_cast<uint8_t>(word >> 8);
    out[index * 4 + 2] = static_cast<uint8_t>(word >> 16);
    out[index * 4 + 3] = static_cast<uint8_t>(word >> 24);
  }

  return any == 0 ? RunIdResult::AllZero : RunIdResult::Ok;
}

}  // namespace detail
}  // namespace uno_r4
}  // namespace alloy

#endif  // defined(ARDUINO_UNOR4_WIFI)
