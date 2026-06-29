// esp32-robolog.ino — robot black-box recorder (no camera, no audio, NO SD card).
// Records sensor INPUTS + actuator OUTPUTS on one timeline -> rolling JSONL chunks on on-chip
// LittleFS -> each chunk uploaded DIRECTLY to the Alloy data API then deleted. UNLIMITED runtime.
//
// The recorder rolls a new chunk every CHUNK_MS/CHUNK_BYTES; a separate ChunkUploader task uploads
// and deletes closed chunks, so the TLS upload never blocks recording. If WiFi drops, chunks queue
// on flash (bounded; drop-oldest) and flush when it returns = store-and-forward. The pending buffer
// can never overrun the FS (openNextChunk sheds oldest chunks if flash is full).
//
// Board: ESP32 / ESP32-S3. Libs: ArduinoJson. SNTP for SigV4 UTC clock.
// Config (WiFi + Alloy key) lives in secrets.h (gitignored) — copy secrets.h.example.

#include <WiFi.h>
#include <LittleFS.h>
#include "secrets.h"
#include "RoboLog.h"
#include "AlloyUploader.h"
#include "ChunkUploader.h"

RoboLog logger;
AlloyUploader alloy;
ChunkUploader chunker;

uint16_t CH_IMU, CH_M0, CH_M1, CH_ENC, CH_ANALOG, CH_ESTOP, CH_MODE;

static const uint32_t CONTROL_HZ = 1000;               // controller rate
static const uint32_t LOG_HZ     = 50;                 // recorder rate (decimated)
static const uint32_t LOG_EVERY  = CONTROL_HZ / LOG_HZ;

// Rolling-chunk upload: roll every CHUNK_MS or CHUNK_BYTES (whichever first); each closed chunk
// uploads to Alloy then is deleted, so RUNTIME IS UNLIMITED on flash alone. Sustained logging rate
// is bounded by upload throughput (~one R2 PUT per chunk over WiFi); if the uplink can't keep up,
// the oldest pending chunks are shed (counted as chunks_dropped), recording never stalls.
static const uint32_t CHUNK_MS    = 8000;              // ~8s per chunk...
static const uint32_t CHUNK_BYTES = 300000;            // ...or ~300KB, whichever first
static const uint8_t  CHUNK_QDEPTH = 5;                // max pending chunks buffered before drop-oldest
static const uint32_t RUN_SECONDS = 40;                // demo length; set 0 to run forever

#pragma pack(push,1)
struct ImuRec   { float ax,ay,az,gx,gy,gz; };
struct MotorRec { float cmd, current; int32_t enc; };
struct AnalogRec{ uint16_t ch[8]; };
#pragma pack(pop)

void setup() {
  Serial.begin(115200);
  if (!LittleFS.begin(true)) { Serial.println("LittleFS fail"); while(1) delay(1000); }
  // clear any leftover chunk files from a previous boot (we don't resume undelivered chunks yet)
  { File root = LittleFS.open("/"); for (File f = root.openNextFile(); f; f = root.openNextFile()) {
      String n = f.name(); f.close();
      if (n.indexOf("c_") >= 0) LittleFS.remove(n.startsWith("/") ? n : ("/" + n)); } }

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print("."); }
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");   // UTC — required for SigV4
  while (time(nullptr) < 1700000000) delay(100);
  alloy.begin(ALLOY_DATA_URL, ALLOY_API_KEY);

  if (!logger.beginRolling(LittleFS, CHUNK_BYTES, CHUNK_MS, /*writerCore=*/1, /*flush=*/64, CHUNK_QDEPTH)) {
    Serial.println("log fail"); while(1) delay(1000);
  }
  if (!chunker.begin(LittleFS, alloy, logger.uploadQueue(), MESH_PATH, /*core=*/1)) {
    Serial.println("uploader fail"); while(1) delay(1000);
  }
  CH_IMU    = logger.channel("imu",     "ax:f32,ay:f32,az:f32,gx:f32,gy:f32,gz:f32");
  CH_M0     = logger.channel("motor0",  "cmd:f32,current:f32,enc:i32");
  CH_M1     = logger.channel("motor1",  "cmd:f32,current:f32,enc:i32");
  CH_ENC    = logger.channel("encoders","left:i32,right:i32");
  CH_ANALOG = logger.channel("analog",  "a0:u16,a1:u16,a2:u16,a3:u16,a4:u16,a5:u16,a6:u16,a7:u16");
  CH_ESTOP  = logger.channel("estop",   "state:u32");
  CH_MODE   = logger.channel("mode",    "state:u32");

  xTaskCreatePinnedToCore(controlTask, "control", 8192, nullptr, configMAX_PRIORITIES-2, nullptr, 0);
}

void loop() { delay(1000); }   // work happens in controlTask

void controlTask(void*) {
  TickType_t next = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(1000 / CONTROL_HZ);
  uint32_t tick = 0;
  uint64_t endAt = logger.nowNs() + (uint64_t)RUN_SECONDS * 1000000000ULL;

  for (;;) {
    uint64_t t = logger.nowNs();          // ONE timestamp this tick -> everything aligned

    // 1. READ (TODO: real sensors; use PCNT for encoders, not ISR-per-edge)
    ImuRec imu = {};
    AnalogRec an; for (int i=0;i<8;i++) an.ch[i] = analogRead(i);
    int32_t encL=0, encR=0;

    // 2. COMPUTE (TODO: your controller)
    float m0=0, m1=0;

    // 3. ACTUATE (TODO: ledcWrite/MCPWM/GPIO)

    // 4. LOG (decimated to LOG_HZ; discrete signals on-change at full rate)
    if (tick % LOG_EVERY == 0) {
      logger.write(CH_IMU, t, &imu, sizeof(imu));
      MotorRec a={m0,0,encL}, b={m1,0,encR};
      logger.write(CH_M0, t, &a, sizeof(a));
      logger.write(CH_M1, t, &b, sizeof(b));
      struct {int32_t l,r;} e={encL,encR}; logger.write(CH_ENC, t, &e, sizeof(e));
      logger.write(CH_ANALOG, t, &an, sizeof(an));
    }
    logger.writeOnChange(CH_ESTOP, 0, digitalRead(0), t);
    logger.writeOnChange(CH_MODE,  1, 0, t);

    if (RUN_SECONDS && t >= endAt) break;   // RUN_SECONDS==0 -> record forever
    tick++;
    vTaskDelayUntil(&next, period);
  }

  // ---- finalize: roll the last partial chunk, wait for the uploader to drain ----
  Serial.printf("run done, dropped=%u chunks_dropped=%u — flushing final chunk\n",
                logger.dropped(), logger.droppedChunks());
  logger.end();
  while (!chunker.idle()) vTaskDelay(pdMS_TO_TICKS(200));
  Serial.printf("DONE: %u chunks uploaded, %u failed, %u dropped\n",
                chunker.uploaded(), chunker.failed(), logger.droppedChunks());
  vTaskDelete(nullptr);
}
