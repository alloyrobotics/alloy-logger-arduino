#include "AlloyLogger.h"
#include <WiFi.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include <math.h>
#include "esp_timer.h"
#include "driver/gpio.h"          // scope(): ISR service, intr enable/disable
#include "soc/gpio_struct.h"      // scope(): GPIO.in/enable/func_*_sel_cfg registers
#include "soc/gpio_periph.h"      // scope(): GPIO_PIN_MUX_REG[]
#include "soc/io_mux_reg.h"       // scope(): FUN_IE/FUN_PU/FUN_PD, PIN_INPUT_ENABLE
#include "soc/gpio_sig_map.h"     // scope(): SIG_GPIO_OUT_IDX

// Alloy object keys allow [A-Za-z0-9_-]; anything else becomes '_'.
static void alloySanitize(char* s) {
  for (; *s; s++) if (!isalnum((uint8_t)*s) && *s != '-' && *s != '_') *s = '_';
}

// ----------------------------- AlloyRecord ---------------------------------
AlloyRecord::AlloyRecord(AlloyLogger* log, const char* chan) : _log(log), _done(false) {
  strncpy(_chan, chan ? chan : "", ALLOY_CHAN_MAX - 1); _chan[ALLOY_CHAN_MAX - 1] = 0;
  uint64_t ns = log ? log->nowNs() : 0;
  _hlen = snprintf(_hdr, ALLOY_HDR_MAX, "t_ns");
  // Fixed 19-digit stamp: pre-SNTP boot-relative values get rebased in place before upload
  // (same width, no buffer rebuild). See AlloyLogger::rebaseRows.
  _rlen = snprintf(_row, ALLOY_ROW_MAX, "%019llu", (unsigned long long)ns);
  if (_hlen < 0 || _rlen < 0) { _hlen = _rlen = 0; _done = true; }
  _sig = AlloyLogger::hashStr(_hdr, _hlen);
}

AlloyRecord::AlloyRecord(AlloyRecord&& o) noexcept
  : _log(o._log), _hlen(o._hlen), _rlen(o._rlen), _sig(o._sig), _done(o._done) {
  memcpy(_chan, o._chan, ALLOY_CHAN_MAX);
  if (_hlen > 0 && _hlen < ALLOY_HDR_MAX) memcpy(_hdr, o._hdr, _hlen + 1);
  if (_rlen > 0 && _rlen < ALLOY_ROW_MAX) memcpy(_row, o._row, _rlen + 1);
  o._done = true; o._log = nullptr;
}

AlloyRecord& AlloyRecord::set(const char* name, float v) {
  if (_done || !name) return *this;
  // One snprintf per field (the %.6g). Names are appended with memcpy and folded into the
  // field-set hash incrementally — the header text is only ever written into a buffer once
  // per chunk (see commitRow's needHdr), so keep its per-row cost to a copy.
  int nn = (int)strlen(name);
  bool hfits = _hlen + 1 + nn < ALLOY_HDR_MAX;                  // ",name" + NUL
  int rn;
  if (isfinite(v)) {
    rn = snprintf(_row + _rlen, ALLOY_ROW_MAX - _rlen, ",%.6g", (double)v);
  } else if (_rlen + 2 <= ALLOY_ROW_MAX) {                      // empty cell = null/NaN in CSV
    _row[_rlen] = ','; _row[_rlen + 1] = 0; rn = 1;
  } else {
    rn = ALLOY_ROW_MAX;                                         // force the rollback path
  }
  if (hfits && rn > 0 && rn < ALLOY_ROW_MAX - _rlen) {
    _hdr[_hlen] = ',';
    memcpy(_hdr + _hlen + 1, name, nn + 1);
    _sig = AlloyLogger::hashStr(_hdr + _hlen, 1 + nn, _sig);    // same bytes as the header text
    _hlen += 1 + nn; _rlen += rn;
  } else {                       // field didn't fit — roll back both so header and row stay aligned
    _hdr[_hlen] = 0; _row[_rlen] = 0;
  }
  return *this;
}

AlloyRecord::~AlloyRecord() {
  if (_done || !_log) return;
  if (_rlen > 0) _log->commitRow(_chan, _hdr, _hlen, _row, _rlen, _sig);
}

// ----------------------------- AlloyLogger ---------------------------------
AlloyLogger& AlloyLogger::describe(const char* channel, const char* field,
                                   const char* unit, float lo, float hi, const char* about) {
  if (!channel || !field || _nDesc >= ALLOY_MAX_DESC) return *this;
  Desc& d = _desc[_nDesc++];
  strncpy(d.chan, channel, sizeof(d.chan) - 1); d.chan[sizeof(d.chan)-1] = 0;
  strncpy(d.field, field,  sizeof(d.field) - 1); d.field[sizeof(d.field)-1] = 0;
  d.unit[0] = 0;  if (unit)  { strncpy(d.unit, unit, sizeof(d.unit)-1); d.unit[sizeof(d.unit)-1] = 0; }
  d.about[0] = 0; if (about) { strncpy(d.about, about, sizeof(d.about)-1); d.about[sizeof(d.about)-1] = 0; }
  d.lo = lo; d.hi = hi;
  return *this;
}

// ---- v2: automatic capture ------------------------------------------------
// Static sources for watchSystem() — captureless so they fit float(*)().
static float alloy_sysHeap()   { return (float)ESP.getFreeHeap(); }
static float alloy_sysRssi()   { return (float)WiFi.RSSI(); }
// Seconds, not ms: float's 24-bit mantissa loses ms precision after ~4.6 h of uptime.
static float alloy_sysUptime() { return (float)(esp_timer_get_time() / 1000000.0); }

AlloyLogger& AlloyLogger::addWatch(const char* chan, const char* field,
                                   uint8_t kind, uint8_t pin, float (*fn)()) {
  if (_started || _nWatch >= ALLOY_MAX_WATCH) return *this;   // watches must be registered before begin()
  Watch& w = _watch[_nWatch++];
  strncpy(w.chan,  chan,  ALLOY_CHAN_MAX - 1); w.chan[ALLOY_CHAN_MAX - 1] = 0;
  strncpy(w.field, field, sizeof(w.field) - 1); w.field[sizeof(w.field) - 1] = 0;
  w.kind = kind; w.pin = pin; w.fn = fn;
  return *this;
}

AlloyLogger& AlloyLogger::watchAnalog(uint8_t pin, const char* field) {
  char f[24];
  if (field) { strncpy(f, field, sizeof(f) - 1); f[sizeof(f) - 1] = 0; }
  else snprintf(f, sizeof(f), "adc%u", (unsigned)pin);
  return addWatch("adc", f, 1, pin, nullptr);
}

AlloyLogger& AlloyLogger::watch(const char* channel, const char* field, float (*fn)()) {
  return addWatch(channel, field, 2, 0, fn);
}

float AlloyLogger::readWatch(const Watch& w) {
  switch (w.kind) {
    case 1:  return (float)analogRead(w.pin);
    default: return w.fn ? w.fn() : NAN;
  }
}

// ---- scope(): the software oscilloscope -------------------------------------
// Every pin the sketch configured, streamed change-driven on "io": gpioN = pad level,
// gpioN_hz = toggle frequency. Slow pins are edge-counted by a 3-instruction ISR; fast
// pins (SPI clocks, steppers at speed) NEVER get an ISR — they're classified by a 1ms
// poll-burst first and summarized as frequency. Activity is never invisible: a pulse too
// short to show as a level change still shows as hz > 0.

AlloyLogger& AlloyLogger::scope() {
  if (_started || _scopeOn) return *this;
  _scopeOn = true;
  addWatch("sys", "heap",      2, 0, alloy_sysHeap);
  addWatch("sys", "rssi",      2, 0, alloy_sysRssi);
  addWatch("sys", "uptime_s",  2, 0, alloy_sysUptime);
  describe("sys", "heap", "bytes", NAN, NAN, "free heap");
  describe("sys", "rssi", "dBm", -100, 0, "WiFi signal strength");
  describe("sys", "uptime_s", "s", NAN, NAN, "time since boot");
  return *this;
}

// Count level transitions on a pin by spinning on the input register for `us` microseconds.
// Faithful to ~1MHz; undercounts above (a measured floor — "very fast" is the honest answer).
uint32_t AlloyLogger::scopePollBurst(uint8_t pin, uint32_t us) {
  uint32_t n = 0;
  uint32_t bit = 1UL << (pin & 31);
  volatile uint32_t* reg = (pin < 32) ? &GPIO.in : &GPIO.in1.val;
  bool last = (*reg & bit) != 0;
  uint32_t t0 = micros();
  while ((uint32_t)(micros() - t0) < us) {
    bool v = (*reg & bit) != 0;
    if (v != last) { n++; last = v; }
  }
  return n;
}

// IRAM so it keeps counting during flash ops. Only ever increments and CLEARS int_ena —
// self-disarming bounds an interrupt storm even if the sampler task is starved.
void IRAM_ATTR AlloyLogger::scopeIsrHandler(void* arg) {
  ScopeIsr* c = (ScopeIsr*)arg;
  c->edges = c->edges + 1;
  if (c->edges - c->tickBase > ALLOY_SCOPE_BURST_CAP) GPIO.pin[c->pin].int_ena = 0;
}

void AlloyLogger::scopeAddPin(uint8_t pin) {
  if (_nScope >= ALLOY_MAX_SCOPE || (_scopeMask >> pin) & 1) return;
  ScopePin& sp = _scope[_nScope++];
  sp.pin = pin; sp.mode = 2; sp.quiet = 0; sp.hz = 0;
  sp.prevEdges = 0; sp.isr.edges = 0; sp.isr.tickBase = 0; sp.isr.pin = pin;
  _scopeMask |= (1ULL << pin);
  // Output pads have the input buffer off (FUN_IE=0) — GPIO.in and interrupts would read
  // nothing. Turning it on is harmless. Never pinMode() here: it would destroy the GPIO
  // matrix routing of peripheral pins (I2C/SPI/PWM).
  PIN_INPUT_ENABLE(GPIO_PIN_MUX_REG[pin]);
  char f[16];
  snprintf(f, sizeof(f), "gpio%u", (unsigned)pin);
  describe("io", f, nullptr, 0, 1, "pad level (auto-discovered by scope())");
  snprintf(f, sizeof(f), "gpio%u_hz", (unsigned)pin);
  describe("io", f, "Hz", NAN, NAN, "toggle frequency, measured floor");
}

// Which pins does this sketch actually use? Read the hardware's own config: software
// outputs, pins routed to peripherals through the GPIO matrix (either direction), and
// inputs with a pull configured. Cheap enough to re-run every ~2s to catch late pinMode()s.
void AlloyLogger::scopeScan() {
  uint64_t inUse = ((uint64_t)GPIO.enable1.val << 32) | GPIO.enable;      // software outputs
  for (int p = 0; p < 40; p++)                                            // peripheral outputs
    if (GPIO.func_out_sel_cfg[p].func_sel != SIG_GPIO_OUT_IDX) inUse |= (1ULL << p);
  for (int sig = 0; sig < 256; sig++) {                                   // peripheral inputs
    if (GPIO.func_in_sel_cfg[sig].sig_in_sel && GPIO.func_in_sel_cfg[sig].func_sel < 40)
      inUse |= (1ULL << GPIO.func_in_sel_cfg[sig].func_sel);
  }
  for (int p = 0; p < 40; p++) {                                          // configured inputs
    if (!GPIO_IS_VALID_GPIO((gpio_num_t)p)) continue;
    uint32_t mux = REG_READ(GPIO_PIN_MUX_REG[p]);
    // pins 34-39 have no pull circuitry, so bare FUN_IE is the configured-input signal there
    if ((mux & FUN_IE) && ((mux & (FUN_PU | FUN_PD)) || p >= 34)) inUse |= (1ULL << p);
  }

  inUse &= ~(0x3FULL << 6);                                // flash pins 6-11: never touch
  inUse &= ~((1ULL << 1) | (1ULL << 3));                   // UART0 TX/RX (serial console)
  if (psramFound()) inUse &= ~((1ULL << 16) | (1ULL << 17)); // WROVER PSRAM clock/cs: fatal to probe
  for (uint8_t i = 0; i < _nWatch; i++)                    // pins the user watches as analog
    if (_watch[i].kind == 1) inUse &= ~(1ULL << _watch[i].pin);

  for (int p = 0; p < 40; p++)
    if (((inUse >> p) & 1) && GPIO_IS_VALID_GPIO((gpio_num_t)p)) scopeAddPin((uint8_t)p);
}

void AlloyLogger::scopeInit() {
  // ESP_ERR_INVALID_STATE = the sketch already installed the service — fine, share it.
  gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
}

// Full edge-counting attach. Safe to call repeatedly: handler_add replaces the existing entry.
void AlloyLogger::scopeAttach(ScopePin& sp) {
  sp.prevEdges = sp.isr.edges; sp.isr.tickBase = sp.isr.edges;
  gpio_set_intr_type((gpio_num_t)sp.pin, GPIO_INTR_ANYEDGE);
  gpio_isr_handler_add((gpio_num_t)sp.pin, scopeIsrHandler, (void*)&sp.isr);
  gpio_intr_enable((gpio_num_t)sp.pin);
  sp.mode = 0;
}

// Poll-burst FIRST, attach an ISR only if the pin is provably slow. This is what makes a
// 26MHz SPI clock safe: it's detected in 1ms of polling and never gets an interrupt at all.
void AlloyLogger::scopeClassify(ScopePin& sp) {
  uint32_t tr = scopePollBurst(sp.pin, 1000);
  if (tr >= 2) {                                           // >= ~1kHz: frequency-summarized
    sp.mode = 1; sp.hz = tr * 500.0f;
  } else {
    scopeAttach(sp);
  }
}

void AlloyLogger::scopeTick() {
  _scopeTicks++;
  bool periodic = (_scopeTicks % 20) == 0;                 // ~2s at the default 100ms tick
  if (periodic) scopeScan();                               // catch pins configured after begin()
  float tickSec = (_sampleMs ? _sampleMs : 100) / 1000.0f;
  bool activity = false;

  for (uint8_t i = 0; i < _nScope; i++) {
    ScopePin& sp = _scope[i];
    if (sp.mode == 2) { scopeClassify(sp); activity = true; continue; }

    if (sp.mode == 0) {                                    // ISR edge-counted
      uint32_t e = sp.isr.edges;
      uint32_t delta = e - sp.prevEdges;
      sp.prevEdges = e; sp.isr.tickBase = e;
      if (delta > ALLOY_SCOPE_FAST_PER_TICK) {             // too chatty for interrupts
        gpio_intr_disable((gpio_num_t)sp.pin);
        sp.mode = 1; sp.quiet = 0;
      }
      float hz = delta / (2.0f * tickSec);
      if (delta > 0 || hz != sp.hz) activity = true;
      sp.hz = hz;
    } else if (periodic) {                                 // FAST: re-measure every ~2s
      uint32_t tr = scopePollBurst(sp.pin, 1000);
      float hz = tr * 500.0f;                              // transitions/ms * 1000 / 2
      if (hz != sp.hz) activity = true;
      sp.hz = hz;
      if (tr == 0) {
        if (++sp.quiet >= 3) {                             // gone quiet: back to edge-accurate
          sp.quiet = 0;
          scopeAttach(sp);                                 // full attach: the pin may have been
        }                                                  // FAST from birth (no handler yet)
      } else sp.quiet = 0;
    }
  }

  uint64_t lv = (((uint64_t)GPIO.in1.val << 32) | GPIO.in) & _scopeMask;
  if (lv != _scopeLevels) activity = true;

  _scopeSinceRow++;
  if (!activity && _scopeSinceRow < 64) return;            // heartbeat row every ~6.4s when idle
  _scopeSinceRow = 0;
  _scopeLevels = lv;

  AlloyRecord r = log("io");
  char f[16];
  for (uint8_t i = 0; i < _nScope; i++) {
    ScopePin& sp = _scope[i];
    snprintf(f, sizeof(f), "gpio%u", (unsigned)sp.pin);
    r.set(f, (int)((lv >> sp.pin) & 1));
    snprintf(f, sizeof(f), "gpio%u_hz", (unsigned)sp.pin);
    r.set(f, sp.hz);
  }
}

// Build one aligned row per distinct channel, reading each of that channel's watched fields.
void AlloyLogger::sampleTick() {
  for (uint8_t i = 0; i < _nWatch; i++) {
    bool first = true;                                    // process a channel only at first sight
    for (uint8_t k = 0; k < i; k++)
      if (!strcmp(_watch[k].chan, _watch[i].chan)) { first = false; break; }
    if (!first) continue;

    AlloyRecord r = log(_watch[i].chan);
    for (uint8_t j = i; j < _nWatch; j++)
      if (!strcmp(_watch[j].chan, _watch[i].chan)) r.set(_watch[j].field, readWatch(_watch[j]));
    // r commits (one CSV row, wall-clock stamped) as it leaves scope
  }
}

void AlloyLogger::samplerTramp(void* self) { static_cast<AlloyLogger*>(self)->samplerLoop(); }

void AlloyLogger::samplerLoop() {
  // No need to wait for SNTP: pre-sync rows carry boot-relative stamps and get rebased on upload.
  if (_scopeOn) scopeInit();   // ISR service installs here so interrupts land on _core
  const TickType_t period = pdMS_TO_TICKS(_sampleMs ? _sampleMs : 100);
  TickType_t next = xTaskGetTickCount();
  for (;;) { if (_scopeOn) scopeTick(); sampleTick(); vTaskDelayUntil(&next, period); }
}

uint64_t AlloyLogger::nowNs() {
  // Before SNTP lands, stamp with boot-relative ns (< 1e18, vs ~1.8e18 for real epoch ns);
  // the uploader rebases those rows to wall-clock once the offset is known.
  if (time(nullptr) < ALLOY_EPOCH_SANE) return (uint64_t)esp_timer_get_time() * 1000ULL;
  struct timeval tv; gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000000000ULL + (uint64_t)tv.tv_usec * 1000ULL;
}

uint32_t AlloyLogger::hashStr(const char* s, int n, uint32_t h) {
  // FNV-1a — cheap field-set fingerprint. Seedable so AlloyRecord can fold names in one at a
  // time as set() appends them, matching a single pass over the full header text.
  for (int i = 0; i < n; i++) { h ^= (uint8_t)s[i]; h *= 16777619u; }
  return h;
}

// frees everything begin() allocated, so a failed begin() can be retried safely
void AlloyLogger::teardown() {
  if (_pool) { for (uint8_t i = 0; i < _nBuf; i++) free(_pool[i].data); delete[] _pool; _pool = nullptr; }
  if (_freeQ)    { vQueueDelete(_freeQ);    _freeQ = nullptr; }
  if (_pendingQ) { vQueueDelete(_pendingQ); _pendingQ = nullptr; }
  if (_mtx)      { vSemaphoreDelete(_mtx);  _mtx = nullptr; }
}

bool AlloyLogger::begin(const char* apiKey, const char* meshPath, const char* dataUrl) {
  if (_started) return true;
  _apiKey = apiKey; _meshPath = meshPath;
  if (_dev) { strncpy(_devId, _dev, sizeof(_devId)-1); _devId[sizeof(_devId)-1] = 0; }
  else {
    // Default device id = sketch filename: ".../MyRobot.ino.cpp" -> "MyRobot" (see _sketchFile)
    const char* base = strrchr(_sketchFile, '/');  base = base ? base + 1 : _sketchFile;
    const char* bs   = strrchr(base, '\\');        if (bs) base = bs + 1;   // Windows build paths
    strncpy(_devId, base, sizeof(_devId)-1); _devId[sizeof(_devId)-1] = 0;
    char* dot = strchr(_devId, '.'); if (dot) *dot = 0;
    if (!_devId[0]) snprintf(_devId, sizeof(_devId), "esp32-%06llx", (unsigned long long)(ESP.getEfuseMac() & 0xFFFFFF));
  }
  alloySanitize(_devId);                               // _devId ends up in object keys

  if (_ssid && WiFi.status() != WL_CONNECTED) {
    WiFi.begin(_ssid, _pass);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(200);
  }
  if (WiFi.status() != WL_CONNECTED) return false;

  // UTC clock: cloud mode needs it for t_ns stamps + the session id; direct mode also for SigV4
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  if (_direct) _up.begin(dataUrl, apiKey, _insecure);
  else         _cloud.begin(_ingestUrl, apiKey, _insecure);

  _pool = new Buf[_nBuf]();
  _freeQ = xQueueCreate(_nBuf, sizeof(Buf*));
  _pendingQ = xQueueCreate(_nBuf, sizeof(Buf*));
  _mtx = xSemaphoreCreateMutex();
  if (!_pool || !_freeQ || !_pendingQ || !_mtx) { teardown(); return false; }
  for (uint8_t i = 0; i < _nBuf; i++) {
    _pool[i].data = (char*)malloc(_bufBytes); _pool[i].len = 0; _pool[i].chan[0] = 0;
    if (!_pool[i].data) { teardown(); return false; }
    Buf* p = &_pool[i]; xQueueSend(_freeQ, &p, 0);
  }

  // Discover scope() pins now, before the uploader starts, so their describe() entries
  // make it into the meta.json sidecar (uploaded first). Classification/ISRs come later,
  // in the sampler task. Pins configured after begin() are caught by the ~2s re-scan.
  if (_scopeOn) scopeScan();

  _started = true;
  xTaskCreatePinnedToCore(taskTramp, "alloy_up", 12288, this, 4, nullptr, _core);
  if (_nWatch > 0 || _scopeOn)   // v2: drive watch()/scope() signals with no code in the user's loop
    xTaskCreatePinnedToCore(samplerTramp, "alloy_smp", 8192, this, 3, nullptr, _core);
  return true;
}

// caller holds _mtx
AlloyLogger::Slot* AlloyLogger::slotFor(const char* chan) {
  for (uint8_t i = 0; i < _nSlots; i++) if (!strcmp(_slots[i].chan, chan)) return &_slots[i];
  if (_nSlots >= ALLOY_MAX_CHANNELS) return nullptr;
  Slot& s = _slots[_nSlots++];
  strncpy(s.chan, chan, ALLOY_CHAN_MAX - 1); s.chan[ALLOY_CHAN_MAX - 1] = 0;
  s.active = nullptr; s.since = 0; s.sig = 0;
  return &s;
}

void AlloyLogger::commitRow(const char* chan, const char* hdr, int hlen, const char* row, int rlen,
                            uint32_t sig) {
  if (!_started) return;
  if ((size_t)hlen + 1 + (size_t)rlen + 1 > _bufBytes) return;   // row can never fit a buffer — drop
  xSemaphoreTake(_mtx, portMAX_DELAY);

  Slot* s = slotFor(chan);
  if (!s) { xSemaphoreGive(_mtx); return; }                 // too many channels — drop

  // Field set changed mid-stream → close the current chunk so each file has one consistent schema.
  if (s->active && s->active->len > 0 && s->sig != sig) { seal(s->active); s->active = nullptr; }

  if (!s->active) {
    s->active = getFree();
    if (!s->active) { xSemaphoreGive(_mtx); return; }
    s->active->len = 0;
    strncpy(s->active->chan, chan, ALLOY_CHAN_MAX - 1); s->active->chan[ALLOY_CHAN_MAX - 1] = 0;
    alloySanitize(s->active->chan);
    s->since = millis(); s->sig = sig;
  }

  Buf* b = s->active;
  bool needHdr = (b->len == 0);
  size_t need = (needHdr ? (size_t)hlen + 1 : 0) + (size_t)rlen + 1;
  if (b->len + need > _bufBytes) {                           // chunk full → seal, start a fresh one
    seal(b); s->active = getFree(b);                         // never cannibalise the chunk just sealed
    if (!s->active) { xSemaphoreGive(_mtx); return; }
    b = s->active; b->len = 0;
    strncpy(b->chan, chan, ALLOY_CHAN_MAX - 1); b->chan[ALLOY_CHAN_MAX - 1] = 0;
    alloySanitize(b->chan);
    s->since = millis(); s->sig = sig; needHdr = true;
  }

  if (needHdr) { memcpy(b->data + b->len, hdr, hlen); b->len += hlen; b->data[b->len++] = '\n'; }
  memcpy(b->data + b->len, row, rlen); b->len += rlen; b->data[b->len++] = '\n';

  // 90%-full seals unconditionally — that's genuine backpressure. A time-based flush instead
  // claims its replacement buffer atomically (or defers): otherwise simultaneous multi-channel
  // flushes race for one free buffer and shed each other's sealed data.
  if (b->len >= (_bufBytes * 9) / 10) {
    seal(b); s->active = nullptr;
  } else if ((millis() - s->since) >= _flushMs) {
    Buf* nb;
    if (xQueueReceive(_freeQ, &nb, 0) == pdTRUE) {
      nb->len = 0; memcpy(nb->chan, b->chan, ALLOY_CHAN_MAX);
      seal(b); s->active = nb; s->since = millis();
    }
  }
  xSemaphoreGive(_mtx);
}

// caller holds _mtx
AlloyLogger::Buf* AlloyLogger::getFree(Buf* avoid) {
  Buf* b = nullptr;
  if (xQueueReceive(_freeQ, &b, 0) == pdTRUE) return b;
  if (xQueueReceive(_pendingQ, &b, 0) == pdTRUE) {          // shed oldest pending
    if (b == avoid) { xQueueSend(_pendingQ, &b, 0); return nullptr; }  // sole pending is the chunk we just sealed — drop the new row instead
    _droppedBufs++; b->len = 0; return b;
  }
  return nullptr;
}

// caller holds _mtx
void AlloyLogger::seal(Buf* b) {
  if (xQueueSend(_pendingQ, &b, 0) != pdTRUE) {
    Buf* old;
    if (xQueueReceive(_pendingQ, &old, 0) == pdTRUE) { old->len = 0; _droppedBufs++; xQueueSend(_freeQ, &old, 0); }
    xQueueSend(_pendingQ, &b, 0);
  }
}

String AlloyLogger::buildMetaJson() {
  JsonDocument doc;                                  // ArduinoJson handles string escaping
  doc["device"] = _devId;
  if (_fw) doc["firmware"] = _fw;
  time_t t = _session; struct tm tm; gmtime_r(&t, &tm);
  char iso[24]; strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &tm);
  doc["session"] = iso;
  JsonArray fields = doc["fields"].to<JsonArray>();
  for (uint8_t i = 0; i < _nDesc; i++) {
    Desc& d = _desc[i];
    JsonObject f = fields.add<JsonObject>();
    f["channel"] = d.chan; f["name"] = d.field;
    if (d.unit[0])      f["unit"]  = d.unit;
    if (isfinite(d.lo)) f["min"]   = d.lo;
    if (isfinite(d.hi)) f["max"]   = d.hi;
    if (d.about[0])     f["about"] = d.about;
  }
  String s; serializeJson(doc, s);
  return s;
}

// Rows stamped before SNTP sync carry boot-relative ns (19 zero-padded digits, < 1e18).
// Rewrite them to wall-clock ns in place: same width, so the buffer layout is untouched.
void AlloyLogger::rebaseRows(Buf* b) {
  if (!_bootOffsetNs) return;
  char* p = b->data; char* end = b->data + b->len;
  while (p < end) {
    char* nl = (char*)memchr(p, '\n', end - p);
    size_t linelen = nl ? (size_t)(nl - p) : (size_t)(end - p);
    if (linelen >= 19 && (linelen == 19 || p[19] == ',')) {
      bool digits = true;
      for (int i = 0; i < 19; i++) if (p[i] < '0' || p[i] > '9') { digits = false; break; }
      if (digits) {
        uint64_t v = 0; for (int i = 0; i < 19; i++) v = v * 10 + (uint64_t)(p[i] - '0');
        if (v < 1000000000000000000ULL) {            // boot-relative → add the sync offset
          v += _bootOffsetNs;
          for (int i = 18; i >= 0; i--) { p[i] = '0' + (char)(v % 10); v /= 10; }
        }
      }
    }
    p += linelen + 1;                                // skip past the '\n' (or off the end)
  }
}

// Graceful end-of-run: seal everything, give the uploader a bounded window to drain, then ask
// the cloud service to finalize the .mcap immediately (instead of the inactivity wait —
// ~2 min by default, see finalizeAfter()).
void AlloyLogger::end(uint32_t drainMs) {
  if (!_started || _direct) return;

  xSemaphoreTake(_mtx, portMAX_DELAY);
  for (uint8_t i = 0; i < _nSlots; i++) {
    Slot& s = _slots[i];
    if (s.active && s.active->len > 0) { seal(s.active); s.active = nullptr; }
  }
  xSemaphoreGive(_mtx);

  uint32_t t0 = millis();
  while (millis() - t0 < drainMs && uxQueueMessagesWaiting(_pendingQ) > 0)
    vTaskDelay(pdMS_TO_TICKS(50));
  vTaskDelay(pdMS_TO_TICKS(500));   // grace for a PUT the task already dequeued

  _cloud.postEnd();
}

void AlloyLogger::taskTramp(void* self) { static_cast<AlloyLogger*>(self)->taskLoop(); }

void AlloyLogger::taskLoop() {
  while (time(nullptr) < ALLOY_EPOCH_SANE) vTaskDelay(pdMS_TO_TICKS(200));  // wait for SNTP (SigV4 needs UTC)
  _session = (uint32_t)time(nullptr);

  // Clock is now real: capture the boot→wall offset used to rebase pre-sync row stamps.
  struct timeval tv; gettimeofday(&tv, nullptr);
  uint64_t wallNs = (uint64_t)tv.tv_sec * 1000000000ULL + (uint64_t)tv.tv_usec * 1000ULL;
  _bootOffsetNs = wallNs - (uint64_t)esp_timer_get_time() * 1000ULL;

  // Each power-on gets its OWN folder under meshPath (a separate mission in Alloy).
  String sessionMesh = String(_meshPath) + "/" + String(_session);
  if (!_direct) _cloud.session(_devId, _session, _meshPath, _finalizeMs);

  // upload the semantics sidecar first (Alloy ingests metadata before data)
  String meta = buildMetaJson();
  char fn[64]; snprintf(fn, sizeof(fn), "%s_meta.json", _devId);
  for (int a = 0; a <= 3; a++) {
    bool ok = _direct
      ? _up.uploadBuffer((const uint8_t*)meta.c_str(), meta.length(), fn, sessionMesh.c_str(), "application/json")
      : _cloud.postMeta((const uint8_t*)meta.c_str(), meta.length());
    if (ok) break;
    vTaskDelay(pdMS_TO_TICKS(1000UL << a));
  }

  Buf* b;
  for (;;) {
    if (xQueueReceive(_pendingQ, &b, pdMS_TO_TICKS(250)) == pdTRUE) {
      rebaseRows(b);
      uint32_t seq = _seq++;                 // once per buffer — retries must reuse it (dedupe key)
      snprintf(fn, sizeof(fn), "%s_%s_%lu.csv", _devId, b->chan, (unsigned long)seq);
      bool ok = false, stale = false;
      for (int a = 0; a <= 4 && !ok; a++) {
        if (a) vTaskDelay(pdMS_TO_TICKS(1000UL << (a - 1)));
        ok = _direct
          ? _up.uploadBuffer((const uint8_t*)b->data, b->len, fn, sessionMesh.c_str(), "text/csv")
          : _cloud.postChunk((const uint8_t*)b->data, b->len, b->chan, seq);
        if (!ok && !_direct && _cloud.last() == 409) { stale = true; break; }  // session finalized — terminal
      }
      if (ok) _uploaded++; else if (stale) _stale++; else _failed++;
      b->len = 0; xQueueSend(_freeQ, &b, 0);
    } else {
      xSemaphoreTake(_mtx, portMAX_DELAY);
      for (uint8_t i = 0; i < _nSlots; i++) {
        Slot& s = _slots[i];
        if (s.active && s.active->len > 0 && (millis() - s.since) >= _flushMs) {
          Buf* nb;                                     // claim the replacement atomically, else retry in 250ms
          if (xQueueReceive(_freeQ, &nb, 0) != pdTRUE) continue;
          nb->len = 0; memcpy(nb->chan, s.active->chan, ALLOY_CHAN_MAX);
          seal(s.active); s.active = nb; s.since = millis();
        }
      }
      xSemaphoreGive(_mtx);
    }
  }
}
