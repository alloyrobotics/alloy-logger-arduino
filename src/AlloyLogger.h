// AlloyLogger — stream Arduino sensor/telemetry data straight to Alloy (usealloy.ai).
//
// Dead-simple, drop-in for any ESP32 Arduino project. You log name→value pairs at the call site;
// the library RAM-buffers them and uploads JSONL to Alloy in the background (no SD, no flash wear,
// never blocks your loop). Alloy AI reasons over the tag + field names + values, so you usually
// don't describe anything — but describe() lets you hand it units/ranges for richer context.
//
//   AlloyLogger alloy;
//   void setup() {
//     alloy.wifi(SSID, PASS);                 // optional — omit if already connected
//     alloy.begin(ALLOY_API_KEY, "robots/sbr");
//   }
//   void loop() {
//     alloy.log("bno055").set("heading", h).set("pitch", p).set("roll", r);  // commits at ';'
//     alloy.log("battery", volts);            // single value
//   }
//
// See README for the full picture. MIT licensed.

#pragma once
#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "AlloyUploader.h"

#ifndef ALLOY_RECORD_MAX
#define ALLOY_RECORD_MAX 320      // max bytes in one JSONL line
#endif
#ifndef ALLOY_MAX_DESC
#define ALLOY_MAX_DESC 48         // max describe() entries
#endif

class AlloyLogger;

// One log record. Built on the stack, commits to the buffer when the statement ends (its ';').
class AlloyRecord {
public:
  AlloyRecord& set(const char* name, float value);
  AlloyRecord& set(const char* name, int value)    { return set(name, (float)value); }
  AlloyRecord& set(const char* name, double value)  { return set(name, (float)value); }
  AlloyRecord& set(const char* name, bool value)    { return set(name, value ? 1.0f : 0.0f); }
  ~AlloyRecord();
  AlloyRecord(AlloyRecord&& o) noexcept;
  AlloyRecord(const AlloyRecord&) = delete;
  AlloyRecord& operator=(const AlloyRecord&) = delete;
private:
  friend class AlloyLogger;
  AlloyRecord(AlloyLogger* log, const char* chan);
  AlloyLogger* _log;
  int  _len;
  bool _done;
  char _buf[ALLOY_RECORD_MAX];
};

class AlloyLogger {
public:
  // ---- optional config (call before begin) ----
  AlloyLogger& wifi(const char* ssid, const char* pass) { _ssid = ssid; _pass = pass; return *this; }
  AlloyLogger& device(const char* id, const char* firmware = nullptr) { _dev = id; _fw = firmware; return *this; }
  AlloyLogger& buffers(uint8_t count, size_t bytes) { _nBuf = count; _bufBytes = bytes; return *this; }
  AlloyLogger& flushEvery(uint32_t ms) { _flushMs = ms; return *this; }
  AlloyLogger& core(int c) { _core = c; return *this; }

  // Optional richer semantics for Alloy AI (units/range/description). Call in setup() before begin().
  AlloyLogger& describe(const char* channel, const char* field,
                        const char* unit = nullptr, float lo = NAN, float hi = NAN,
                        const char* about = nullptr);

  // Connect + start the background uploader. meshPath e.g. "robots/sbr".
  bool begin(const char* apiKey, const char* meshPath,
             const char* dataUrl = "https://data.usealloy.ai");

  // ---- logging ----
  AlloyRecord log(const char* channel) { return AlloyRecord(this, channel); }
  void log(const char* channel, float value) { AlloyRecord(this, channel).set("value", value); }

  // ---- stats ----
  uint32_t uploaded() const { return _uploaded; }
  uint32_t failed() const { return _failed; }
  uint32_t dropped() const { return _droppedBufs; }   // buffers shed under backpressure

  uint64_t nowNs();   // wall-clock ns (gettimeofday); used to stamp records

private:
  friend class AlloyRecord;
  struct Buf { char* data; size_t len; };

  void commitLine(const char* line, int len);
  Buf* getFree();
  void seal(Buf* b);
  static void taskTramp(void* self);
  void taskLoop();
  String buildMetaJson();

  // config
  const char *_ssid = nullptr, *_pass = nullptr, *_dev = nullptr, *_fw = nullptr;
  const char *_apiKey = nullptr, *_meshPath = nullptr;
  uint8_t  _nBuf = 4;
  size_t   _bufBytes = 24 * 1024;
  uint32_t _flushMs = 4000;
  int      _core = 0;

  // describe() store
  struct Desc { char chan[24], field[20], unit[12], about[48]; float lo, hi; };
  Desc    _desc[ALLOY_MAX_DESC]; uint8_t _nDesc = 0;

  // runtime
  AlloyUploader _up;
  Buf*          _pool = nullptr;
  QueueHandle_t _freeQ = nullptr, _pendingQ = nullptr;
  SemaphoreHandle_t _mtx = nullptr;
  Buf*          _active = nullptr;
  uint32_t      _activeSince = 0;
  uint32_t      _session = 0, _seq = 0;
  char          _devId[24] = {0};
  volatile uint32_t _uploaded = 0, _failed = 0, _droppedBufs = 0;
  bool          _started = false;
};
