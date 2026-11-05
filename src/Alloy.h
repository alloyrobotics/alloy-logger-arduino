#pragma once

// Arduino IDE's "Include Library" action inserts the header named by
// library.properties. Dispatch here so a multi-architecture install never
// exposes the other board family's platform-only headers.
#if defined(ARDUINO_ARCH_ESP32)
#include "AlloyStorage.h"
#elif defined(ARDUINO_UNOR4_WIFI)
#include "AlloyUnoR4.h"
#else
#error "The Alloy Storage SDK supports ESP32 and Arduino UNO R4 WiFi boards"
#endif
