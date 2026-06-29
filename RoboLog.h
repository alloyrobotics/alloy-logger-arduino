// RoboLog.h — multimodal control-loop logger for ESP32 (Arduino), JSONL output for direct Alloy ingest.
//
// Two modes:
//   * begin(fs, path)            — single file per run (small runs; finalize with end()).
//   * beginRolling(fs, bytes,ms) — ROLLING chunks for UNLIMITED runtime with no SD: the writer
//                                  rolls a new chunk every `bytes` or `ms`, closes it, and hands it
//                                  to a ChunkUploader task that uploads + deletes it. Recording never
//                                  blocks on the upload. Pending-chunk buffer is bounded (drop-oldest)
//                                  = store-and-forward if WiFi drops.
//
//   * One master clock : esp_timer (us -> ns). The control loop is the heartbeat.
//   * Self-describing   : each channel declares a field layout; the writer emits one JSON object per record.
//   * Hot path is cheap : control loop only memcpy's packed bytes into a bounded queue;
//                         JSON formatting happens in the writer task on core 1.
//   * Backpressure-safe : record queue full -> oldest record dropped (counted); chunk buffer full ->
//                         oldest unsent chunk dropped (counted). The log stays valid JSONL throughout.

#pragma once
#include <Arduino.h>
#include <FS.h>            // filesystem-agnostic: works on SD, LittleFS, etc.
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#ifndef ROBOLOG_MAX_PAYLOAD
#define ROBOLOG_MAX_PAYLOAD 64
#endif
#ifndef ROBOLOG_QUEUE_DEPTH
#define ROBOLOG_QUEUE_DEPTH 256
#endif
#ifndef ROBOLOG_MAX_CHANNELS
#define ROBOLOG_MAX_CHANNELS 24
#endif
#ifndef ROBOLOG_MAX_FIELDS
#define ROBOLOG_MAX_FIELDS 16
#endif

enum RLType { RL_F32, RL_F64, RL_I8, RL_U8, RL_I16, RL_U16, RL_I32, RL_U32, RL_I64, RL_U64 };

struct RLField { char name[12]; RLType type; uint8_t off; };
struct RLChannel { char name[16]; RLField fields[ROBOLOG_MAX_FIELDS]; uint8_t nFields; };
struct RoboLogRecord { uint16_t channel; uint16_t len; uint64_t ts_ns; uint8_t data[ROBOLOG_MAX_PAYLOAD]; };
struct RLChunk { char path[48]; };   // closed chunk handed to the uploader

class RoboLog {
public:
  // Single-file mode.
  bool begin(fs::FS& fs, const char* path, int writerCore = 1, uint32_t flushEveryN = 64) {
    _fs = &fs; _rolling = false; _flushEvery = flushEveryN;
    _file = fs.open(path, FILE_WRITE);
    if (!_file) return false;
    _queue = xQueueCreate(ROBOLOG_QUEUE_DEPTH, sizeof(RoboLogRecord));
    if (!_queue) return false;
    xTaskCreatePinnedToCore(trampoline, "robolog_wr", 6144, this, 5, &_writer, writerCore);
    return true;
  }

  // Rolling mode: roll a chunk every `chunkBytes` OR `chunkMs` (whichever first). Closed chunks are
  // pushed to uploadQueue() for a ChunkUploader. qDepth = max pending chunks before drop-oldest.
  bool beginRolling(fs::FS& fs, uint32_t chunkBytes, uint32_t chunkMs,
                    int writerCore = 1, uint32_t flushEveryN = 64, uint8_t qDepth = 10) {
    _fs = &fs; _rolling = true; _flushEvery = flushEveryN;
    _chunkLimitBytes = chunkBytes; _chunkLimitMs = chunkMs;
    _session = (uint32_t)time(nullptr); _seq = 0;
    _queue    = xQueueCreate(ROBOLOG_QUEUE_DEPTH, sizeof(RoboLogRecord));
    _uploadQ  = xQueueCreate(qDepth, sizeof(RLChunk));
    if (!_queue || !_uploadQ) return false;
    if (!openNextChunk()) return false;
    xTaskCreatePinnedToCore(trampoline, "robolog_wr", 6144, this, 5, &_writer, writerCore);
    return true;
  }

  QueueHandle_t uploadQueue() const { return _uploadQ; }

  uint16_t channel(const char* name, const char* layout) {
    RLChannel& c = _ch[_nCh];
    strncpy(c.name, name, sizeof(c.name) - 1);
    c.nFields = 0; uint8_t off = 0;
    const char* p = layout;
    while (*p && c.nFields < ROBOLOG_MAX_FIELDS) {
      RLField& f = c.fields[c.nFields];
      int i = 0; while (*p && *p != ':' && i < 11) f.name[i++] = *p++; f.name[i] = 0;
      while (*p && *p != ':') p++; if (*p == ':') p++;
      char t[8]; i = 0; while (*p && *p != ',' && i < 7) t[i++] = *p++; t[i] = 0;
      f.type = parseType(t); f.off = off; off += typeSize(f.type);
      c.nFields++;
      if (*p == ',') p++;
    }
    return _nCh++;
  }

  inline uint64_t nowNs() { return (uint64_t)esp_timer_get_time() * 1000ULL; }

  bool write(uint16_t channel, uint64_t ts_ns, const void* payload, uint16_t len) {
    if (len > ROBOLOG_MAX_PAYLOAD) return false;
    RoboLogRecord r; r.channel = channel; r.ts_ns = ts_ns; r.len = len;
    memcpy(r.data, payload, len);
    if (xQueueSend(_queue, &r, 0) != pdTRUE) { _dropped++; return false; }
    return true;
  }

  bool writeOnChange(uint16_t channel, uint8_t slot, uint32_t value, uint64_t ts_ns) {
    if (slot < ROBOLOG_MAX_CHANNELS && _lastValid[slot] && _last[slot] == value) return true;
    _last[slot] = value; _lastValid[slot] = true;
    return write(channel, ts_ns, &value, 4);
  }

  // Single-file: drain + close. Rolling: drain + roll the final partial chunk into uploadQueue().
  void end() {
    while (uxQueueMessagesWaiting(_queue) > 0) vTaskDelay(pdMS_TO_TICKS(10));
    vTaskDelay(pdMS_TO_TICKS(50));
    if (_rolling) { rollChunk(/*final=*/true); }
    else { _file.flush(); _file.close(); }
  }

  uint32_t dropped() const { return _dropped; }
  uint32_t droppedChunks() const { return _droppedChunks; }

private:
  // Pop the oldest pending (not in-flight) chunk and delete it. Returns false if none to drop.
  bool dropOldest() {
    RLChunk old;
    if (xQueueReceive(_uploadQ, &old, 0) == pdTRUE) { _fs->remove(old.path); _droppedChunks++; return true; }
    return false;
  }
  // Open the next chunk; if the FS is full, shed oldest pending chunks until it opens. The writer
  // therefore never stalls on a full FS — backpressure shows up as droppedChunks (bounded), not data corruption.
  bool openNextChunk() {
    for (int tries = 0; tries < 16; tries++) {
      snprintf(_chunkPath, sizeof(_chunkPath), "/c_%u_%lu.jsonl", _session, (unsigned long)_seq);
      _file = _fs->open(_chunkPath, FILE_WRITE);
      if (_file) { _seq++; _chunkBytes = 0; _chunkStartMs = millis(); return true; }
      if (!dropOldest()) return false;          // nothing left to shed
    }
    return false;
  }
  void rollChunk(bool final = false) {
    _file.flush(); _file.close();
    if (_chunkBytes == 0) { _fs->remove(_chunkPath); }   // don't ship an empty chunk
    else {
      RLChunk c; strncpy(c.path, _chunkPath, sizeof(c.path) - 1); c.path[sizeof(c.path)-1] = 0;
      if (xQueueSend(_uploadQ, &c, 0) != pdTRUE) {        // queue full -> drop oldest, keep newest
        dropOldest();
        xQueueSend(_uploadQ, &c, 0);
      }
    }
    if (!final) openNextChunk();
  }

  static RLType parseType(const char* t) {
    if (!strcmp(t,"f32")) return RL_F32; if (!strcmp(t,"f64")) return RL_F64;
    if (!strcmp(t,"i8"))  return RL_I8;  if (!strcmp(t,"u8"))  return RL_U8;
    if (!strcmp(t,"i16")) return RL_I16; if (!strcmp(t,"u16")) return RL_U16;
    if (!strcmp(t,"i32")) return RL_I32; if (!strcmp(t,"u32")) return RL_U32;
    if (!strcmp(t,"i64")) return RL_I64; return RL_U64;
  }
  static uint8_t typeSize(RLType t) {
    switch (t) { case RL_F32: case RL_I32: case RL_U32: return 4;
      case RL_F64: case RL_I64: case RL_U64: return 8;
      case RL_I16: case RL_U16: return 2; default: return 1; }
  }
  static int fieldToJson(char* out, const RLField& f, const uint8_t* d) {
    const uint8_t* p = d + f.off;
    switch (f.type) {
      case RL_F32: { float v; memcpy(&v,p,4); return sprintf(out, "%.6g", v); }
      case RL_F64: { double v; memcpy(&v,p,8); return sprintf(out, "%.10g", v); }
      case RL_I8:  return sprintf(out, "%d",  (int)*(int8_t*)p);
      case RL_U8:  return sprintf(out, "%u",  (unsigned)*p);
      case RL_I16: { int16_t v; memcpy(&v,p,2); return sprintf(out, "%d", v); }
      case RL_U16: { uint16_t v; memcpy(&v,p,2); return sprintf(out, "%u", v); }
      case RL_I32: { int32_t v; memcpy(&v,p,4); return sprintf(out, "%ld", (long)v); }
      case RL_U32: { uint32_t v; memcpy(&v,p,4); return sprintf(out, "%lu", (unsigned long)v); }
      case RL_I64: { int64_t v; memcpy(&v,p,8); return sprintf(out, "%lld", (long long)v); }
      default:     { uint64_t v; memcpy(&v,p,8); return sprintf(out, "%llu", (unsigned long long)v); }
    }
  }
  static void trampoline(void* s) { static_cast<RoboLog*>(s)->writerLoop(); }
  void writerLoop() {
    RoboLogRecord r; char line[512]; uint32_t since = 0;
    for (;;) {
      if (xQueueReceive(_queue, &r, portMAX_DELAY) != pdTRUE) continue;
      RLChannel& c = _ch[r.channel];
      int n = sprintf(line, "{\"ch\":\"%s\",\"t_ns\":%llu", c.name, (unsigned long long)r.ts_ns);
      for (uint8_t i = 0; i < c.nFields; i++) {
        n += sprintf(line + n, ",\"%s\":", c.fields[i].name);
        n += fieldToJson(line + n, c.fields[i], r.data);
      }
      line[n++] = '}'; line[n++] = '\n';
      _file.write((const uint8_t*)line, n);
      if (++since >= _flushEvery) { _file.flush(); since = 0; }
      if (_rolling) {
        _chunkBytes += n;
        if (_chunkBytes >= _chunkLimitBytes || (millis() - _chunkStartMs) >= _chunkLimitMs) rollChunk();
      }
    }
  }

  File _file; fs::FS* _fs = nullptr;
  QueueHandle_t _queue = nullptr, _uploadQ = nullptr;
  TaskHandle_t _writer = nullptr;
  RLChannel _ch[ROBOLOG_MAX_CHANNELS]; uint16_t _nCh = 0;
  uint32_t _flushEvery = 64; volatile uint32_t _dropped = 0;
  uint32_t _last[ROBOLOG_MAX_CHANNELS] = {0}; bool _lastValid[ROBOLOG_MAX_CHANNELS] = {false};
  // rolling state
  bool _rolling = false;
  char _chunkPath[48]; uint32_t _session = 0, _seq = 0;
  uint32_t _chunkLimitBytes = 0, _chunkLimitMs = 0, _chunkBytes = 0; uint32_t _chunkStartMs = 0;
  volatile uint32_t _droppedChunks = 0;
};
