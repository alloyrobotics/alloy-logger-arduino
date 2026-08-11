#pragma once

// Arduino IDE's "Include Library" action inserts the header named by
// library.properties. Dispatch here so a multi-architecture install never
// exposes the other board family's platform-only headers.
#if defined(ARDUINO_ARCH_ESP32)
#include "AlloyLogger.h"
#elif defined(ARDUINO_UNOR4_WIFI)
#include "AlloyUnoR4.h"
#else
#error "AlloyLogger supports ESP32 and Arduino UNO R4 WiFi boards"
#endif
