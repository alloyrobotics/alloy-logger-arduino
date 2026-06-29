// ChunkUploader.h — drains RoboLog's rolling-chunk queue and uploads each closed chunk to Alloy.
//
// Runs on its own FreeRTOS task so the TLS/SigV4 upload (seconds) never blocks recording.
// Each chunk = one upload-session + one SigV4 PutObject (AlloyUploader). On success the local
// chunk file is deleted; on failure it retries with backoff, then drops (the file stays on FS and
// RoboLog's drop-oldest eventually reclaims it — bounded store-and-forward).

#pragma once
#include <FS.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "RoboLog.h"
#include "AlloyUploader.h"

class ChunkUploader {
public:
  // meshPath e.g. "robots/sbr" -> files land under uploads/sdk-uploads/robots/sbr/.
  bool begin(fs::FS& fs, AlloyUploader& up, QueueHandle_t uploadQ, const char* meshPath,
             int core = 1, uint8_t maxRetries = 4) {
    _fs = &fs; _up = &up; _q = uploadQ; _meshPath = meshPath; _maxRetries = maxRetries;
    if (!_q) return false;
    xTaskCreatePinnedToCore(trampoline, "chunk_up", 8192, this, 4, &_task, core);
    return true;
  }

  uint32_t uploaded() const { return _uploaded; }
  uint32_t failed() const { return _failed; }
  bool idle() const { return _q && uxQueueMessagesWaiting(_q) == 0 && !_busy; }

private:
  static void trampoline(void* s) { static_cast<ChunkUploader*>(s)->loop(); }
  void loop() {
    RLChunk c;
    for (;;) {
      if (xQueueReceive(_q, &c, portMAX_DELAY) != pdTRUE) continue;
      _busy = true;
      bool ok = false;
      for (uint8_t attempt = 0; attempt <= _maxRetries && !ok; attempt++) {
        if (attempt) vTaskDelay(pdMS_TO_TICKS(1000UL << (attempt - 1)));   // 1s,2s,4s,8s backoff
        ok = _up->uploadFile(*_fs, c.path, _meshPath);
      }
      if (ok) { _fs->remove(c.path); _uploaded++; }
      else    { _failed++; }   // leave file; RoboLog drop-oldest reclaims space if WiFi stays down
      _busy = false;
    }
  }

  fs::FS* _fs = nullptr; AlloyUploader* _up = nullptr; QueueHandle_t _q = nullptr;
  const char* _meshPath = nullptr; TaskHandle_t _task = nullptr;
  uint8_t _maxRetries = 4;
  volatile bool _busy = false;
  volatile uint32_t _uploaded = 0, _failed = 0;
};
