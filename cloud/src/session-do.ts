// SessionDO — one instance per (keyHash, device, session). The serialization point that makes
// "one run = one MCAP" work: dedupes chunk retries, tracks the run via an inactivity alarm
// (power loss can only be detected server-side — the black box never says goodbye), and on
// finalize k-way-merges the staged CSVs into one indexed MCAP PUT into the user's own mesh.
//
// State machine: receiving → finalizing → done. Finalize is idempotent (the artifact is a
// deterministic PUT), so alarm retries and crashes mid-finalize just redo the work.

import { assembleMcap } from "./mcap";
import { assembleBinaryMcap } from "./binary-mcap";
import {
  AckDetail,
  AckFlag,
  AckStatus,
  FrameType,
  type BinarySchema,
  type WireFrame,
  encodeAck,
  parseBegin,
  parseClockAnchor,
  parseEnd,
  parseFrame,
  parseGap,
  parseSamples,
  parseSchema,
  projectTimestampU64,
  validateStatelessPayload,
} from "./binary";
import type { ChunkSource } from "./csv";
import { mintUploadSession, putToMesh } from "./mesh";
import type { DeviceMeta, Env } from "./types";

const MAX_FINALIZE_ATTEMPTS = 10;
const RATE_LIMIT_PER_MIN = 120;
const MAX_BINARY_SCHEMA_REVISIONS = 255;
// Bounds for the device-chosen inactivity window (X-Alloy-Finalize-Ms). The floor protects a run
// from being split by a routine WiFi hiccup; the ceiling bounds how long staged data can idle.
const FINALIZE_MS_MIN = 30_000;
const FINALIZE_MS_MAX = 30 * 60_000;

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sampleRangeBefore(
  leftMono: string,
  leftSeq: number,
  rightMono: string,
  rightSeq: number,
): boolean {
  const left = BigInt(leftMono);
  const right = BigInt(rightMono);
  return leftSeq < rightSeq && (left < right || (left === right && leftSeq < rightSeq));
}

interface ProjectionAnchorState {
  frameSeq: number;
  id: number;
  quality: number;
  monotonicUs: string;
  utcNs: string;
}

function chooseProjectionAnchor(
  current: ProjectionAnchorState | undefined,
  candidate: ProjectionAnchorState,
): ProjectionAnchorState {
  if (!current) return candidate;
  if (current.quality !== candidate.quality) {
    return candidate.quality === 2 ? candidate : current;
  }
  const currentMono = BigInt(current.monotonicUs);
  const candidateMono = BigInt(candidate.monotonicUs);
  return candidateMono < currentMono ||
    (candidateMono === currentMono && candidate.frameSeq < current.frameSeq)
    ? candidate
    : current;
}

function validateProjectedBounds(
  minimumMonoUs: string | undefined,
  maximumMonoUs: string | undefined,
  anchor: ProjectionAnchorState | undefined,
): void {
  if (minimumMonoUs === undefined || maximumMonoUs === undefined) return;
  const offsetNs = anchor
    ? BigInt(anchor.utcNs) - BigInt(anchor.monotonicUs) * 1000n
    : 0n;
  projectTimestampU64(BigInt(minimumMonoUs), offsetNs);
  projectTimestampU64(BigInt(maximumMonoUs), offsetNs);
}

interface State {
  phase: "receiving" | "finalizing" | "done" | "failed";
  apiKey: string; // held ONLY for the session's lifetime; purged the moment finalize succeeds
  keyHash16: string;
  device: string;
  session: string;
  meshPath: string;
  lastChunkAt: number;
  finalizeAttempts: number;
  inactivityMs: number;
  /** Missing on v1 objects created before the binary route existed; those are CSV sessions. */
  format?: "csv" | "binary";
  runIdHex?: string;
  lowestMissingSeq?: number;
  endSeq?: number;
  binaryMinimumMonoUs?: string;
  binaryMaximumMonoUs?: string;
  binaryProjectionAnchor?: ProjectionAnchorState;
  failure?: "finalize_exhausted";
  failedAt?: number;
}

export class SessionDO implements DurableObject {
  private recentChunks: number[] = []; // sliding-window rate limiter (in-memory is fine per-DO)
  private binaryTail: Promise<void> = Promise.resolve();
  // Inert in production. Worker tests set these primitives directly to exercise the R2-await
  // interleaving/crash boundaries without moving an I/O object across workerd contexts.
  private nextBinaryStageDelayMs = 0;
  private nextBinaryStageFailureAfterPut = false;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS chunks(
         channel TEXT NOT NULL, seq INTEGER NOT NULL, r2key TEXT NOT NULL, bytes INTEGER NOT NULL,
         PRIMARY KEY(channel, seq));`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS binary_frames(
         frame_seq INTEGER PRIMARY KEY, frame_type INTEGER NOT NULL, r2key TEXT NOT NULL,
         bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, request_crc INTEGER NOT NULL,
         dropped_samples INTEGER NOT NULL, dropped_frames INTEGER NOT NULL,
         corrupt_frames INTEGER NOT NULL, backpressure_events INTEGER NOT NULL,
         retry_attempts INTEGER NOT NULL,
         gap_first_frame INTEGER, gap_frame_count INTEGER,
         sample_first_seq INTEGER, sample_last_seq INTEGER,
         sample_first_mono TEXT, sample_last_mono TEXT,
         time_first_mono TEXT, time_last_mono TEXT);`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS binary_schemas(
         schema_id INTEGER NOT NULL, revision INTEGER NOT NULL, channel TEXT NOT NULL,
         frame_seq INTEGER NOT NULL, payload_sha256 TEXT NOT NULL, schema_json TEXT NOT NULL,
         PRIMARY KEY(schema_id, revision));`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS binary_anchors(
         anchor_id INTEGER PRIMARY KEY, frame_seq INTEGER NOT NULL, payload_sha256 TEXT NOT NULL,
         quality INTEGER NOT NULL, monotonic_us TEXT NOT NULL, utc_ns TEXT NOT NULL);`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS binary_session(
         singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL);`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS binary_tombstone(
         singleton INTEGER PRIMARY KEY CHECK(singleton = 1), tombstone_json TEXT NOT NULL);`,
    );
  }

  private binaryState(): State | undefined {
    const row = this.ctx.storage.sql
      .exec<{ state_json: string }>(
        "SELECT state_json FROM binary_session WHERE singleton = 1",
      )
      .toArray()[0];
    return row ? JSON.parse(row.state_json) as State : undefined;
  }

  private writeBinaryState(s: State): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO binary_session(singleton, state_json) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`,
      JSON.stringify(s),
    );
  }

  private async state(): Promise<State | undefined> {
    return this.binaryState() ?? this.ctx.storage.get<State>("state");
  }

  private stagePrefix(s: State): string {
    return `stage/${s.keyHash16}/${s.device}/${s.session}/`;
  }

  private async stageBinaryFrame(r2key: string, bytes: Uint8Array): Promise<R2Object | null> {
    const delayMs = this.nextBinaryStageDelayMs;
    this.nextBinaryStageDelayMs = 0;
    if (delayMs > 0) await scheduler.wait(delayMs);
    const object = await this.env.STAGING.put(r2key, bytes);
    if (this.nextBinaryStageFailureAfterPut) {
      this.nextBinaryStageFailureAfterPut = false;
      throw new Error("injected post-R2/pre-commit failure");
    }
    return object;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = url.pathname; // /v1/* or /v2/frame (Worker validated everything)

    if (route === "/v2/frame") return this.serializedBinaryFrame(req);

    let s = await this.state();

    // Legacy objects predate the format field and are therefore CSV. A format can never change
    // after the first request: mixing would make the final artifact ambiguous.
    if (s?.format === "binary") return new Response("session format is binary", { status: 409 });

    if (s?.phase === "done") {
      return route === "/v1/end" ? new Response(null, { status: 204 }) : new Response("session finalized", { status: 409 });
    }
    if (s?.phase === "finalizing") {
      if (route === "/v1/end") return new Response(null, { status: 202 });
      return new Response("finalize in progress", { status: 503, headers: { "Retry-After": "5" } });
    }

    if (!s) {
      // first request of the run — pin identity + the key we'll need at finalize time
      const apiKey = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const wantMs = Number(req.headers.get("X-Alloy-Finalize-Ms") ?? this.env.INACTIVITY_MS);
      const inactivityMs = Math.min(FINALIZE_MS_MAX, Math.max(FINALIZE_MS_MIN, wantMs || 0));
      s = {
        phase: "receiving",
        apiKey,
        keyHash16: req.headers.get("X-Internal-Key-Hash")!.slice(0, 16),
        device: req.headers.get("X-Alloy-Device")!,
        session: req.headers.get("X-Alloy-Session")!,
        meshPath: req.headers.get("X-Alloy-Mesh-Path")!,
        lastChunkAt: Date.now(),
        finalizeAttempts: 0,
        inactivityMs,
        format: "csv",
      };
      await this.ctx.storage.put("state", s);
    }

    switch (route) {
      case "/v1/chunk":
        return this.onChunk(req, s);
      case "/v1/meta":
        return this.onMeta(req, s);
      case "/v1/end":
        return this.onEnd(s);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  /**
   * R2 awaits permit Durable Object request interleaving. Keep the entire binary state transition
   * serialized so no request can ACK data derived from a frame another request later rolls back.
   * Alarms use this same queue, so finalization always observes one committed frame snapshot.
   */
  private async withBinaryLock<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.binaryTail;
    let release!: () => void;
    this.binaryTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private serializedBinaryFrame(req: Request): Promise<Response> {
    return this.withBinaryLock(async () => this.onBinaryFrame(req, await this.state()));
  }

  private binaryAck(
    frame: WireFrame,
    status: AckStatus,
    flags: number,
    detail: AckDetail,
    httpStatus: number,
    lowestMissingSeq: number,
    retryAfterMs = 0,
  ): Response {
    const body = encodeAck({
      status,
      flags,
      detail,
      ackSeq: frame.header.frameSeq,
      lowestMissingSeq,
      retryAfterMs,
      runId: frame.header.runId,
      requestCrc32c: frame.header.crc32c,
    });
    return new Response(body, {
      status: httpStatus,
      headers: {
        "Content-Type": "application/vnd.alloy.ack;version=1",
        "Cache-Control": "no-store",
        "X-Alloy-Server-UTC-Ns": (BigInt(Date.now()) * 1_000_000n).toString(),
        ...(retryAfterMs > 0 ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {}),
      },
    });
  }

  private binaryLowestMissing(start = 0): number {
    let next = start;
    for (;;) {
      if (next >= 0xffffffff) return 0xffffffff;
      const frame = this.ctx.storage.sql
        .exec<{ frame_seq: number }>(
          "SELECT frame_seq FROM binary_frames WHERE frame_seq = ?",
          next,
        )
        .toArray()[0];
      if (frame) {
        next++;
        continue;
      }
      const gap = this.ctx.storage.sql
        .exec<{ gap_end: number }>(
          `SELECT gap_first_frame + gap_frame_count AS gap_end
             FROM binary_frames
            WHERE gap_first_frame IS NOT NULL AND gap_frame_count IS NOT NULL
              AND gap_first_frame != 4294967295 AND gap_frame_count != 4294967295
              AND gap_first_frame <= ? AND gap_first_frame + gap_frame_count > ?
            ORDER BY gap_end DESC LIMIT 1`,
          next,
          next,
        )
        .toArray()[0];
      if (!gap) return next;
      next = gap.gap_end;
    }
  }

  private loadBinarySchemas(): Map<string, { schema: BinarySchema; frameSeq: number }> {
    const schemas = new Map<string, { schema: BinarySchema; frameSeq: number }>();
    const rows = this.ctx.storage.sql
      .exec<{ schema_id: number; revision: number; frame_seq: number; schema_json: string }>(
        "SELECT schema_id, revision, frame_seq, schema_json FROM binary_schemas",
      )
      .toArray();
    for (const row of rows) {
      schemas.set(`${row.schema_id}/${row.revision}`, {
        schema: JSON.parse(row.schema_json) as BinarySchema,
        frameSeq: row.frame_seq,
      });
    }
    return schemas;
  }

  private async onBinaryFrame(req: Request, existing: State | undefined): Promise<Response> {
    const bytes = new Uint8Array(await req.arrayBuffer());
    let frame: WireFrame;
    try {
      frame = parseFrame(bytes);
      validateStatelessPayload(frame);
    } catch {
      // The Worker only forwards valid envelopes, so this is a defense-in-depth path without a
      // trustworthy seq/run/request CRC from which a reclaimable ACK could be constructed.
      return new Response("malformed binary frame", { status: 400 });
    }

    let s = existing;
    if (s && s.format !== "binary") {
      return this.binaryAck(
        frame,
        AckStatus.ProtocolFormatConflict,
        0,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? 0,
      );
    }

    const headerDevice = req.headers.get("X-Alloy-Device")!;
    const headerMeshPath = req.headers.get("X-Alloy-Mesh-Path")!;
    if (!s) {
      if (frame.header.type !== FrameType.Begin || frame.header.frameSeq !== 0) {
        return this.binaryAck(frame, AckStatus.RunNotStarted, 0, AckDetail.None, 409, 0);
      }
      const begin = parseBegin(frame.payload);
      if (begin.device !== headerDevice) {
        return this.binaryAck(frame, AckStatus.IdentityConflict, 0, AckDetail.None, 409, 0);
      }
      const apiKey = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const wantMs = Number(req.headers.get("X-Alloy-Finalize-Ms") ?? this.env.INACTIVITY_MS);
      const inactivityMs = Math.min(FINALIZE_MS_MAX, Math.max(FINALIZE_MS_MIN, wantMs || 0));
      s = {
        phase: "receiving",
        apiKey,
        keyHash16: req.headers.get("X-Internal-Key-Hash")!.slice(0, 16),
        device: begin.device,
        session: frame.header.runIdHex,
        meshPath: headerMeshPath,
        lastChunkAt: Date.now(),
        finalizeAttempts: 0,
        inactivityMs,
        format: "binary",
        runIdHex: frame.header.runIdHex,
        lowestMissingSeq: 0,
      };
    }

    if (
      s.runIdHex !== frame.header.runIdHex ||
      s.device !== headerDevice ||
      s.meshPath !== headerMeshPath
    ) {
      return this.binaryAck(
        frame,
        AckStatus.IdentityConflict,
        0,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? 0,
      );
    }

    if (s.phase === "failed") {
      s = {
        ...s,
        phase: "finalizing",
        apiKey: (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, ""),
        finalizeAttempts: 0,
        failure: undefined,
        failedAt: undefined,
      };
      // Arm before rehydrating the credential: either the failed/keyless state survives, or a
      // finalizing state always has a durable alarm that will clear the credential again.
      await this.ctx.storage.setAlarm(Date.now());
      this.ctx.storage.transactionSync(() => this.writeBinaryState(s!));
      return this.binaryAck(
        frame,
        AckStatus.Busy,
        AckFlag.Retryable,
        AckDetail.None,
        503,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
        1000,
      );
    }

    const digest = await sha256Bytes(bytes);
    const prior = this.ctx.storage.sql
      .exec<{ bytes: number; sha256: string }>(
        "SELECT bytes, sha256 FROM binary_frames WHERE frame_seq = ?",
        frame.header.frameSeq,
      )
      .toArray()[0];
    if (prior) {
      if (prior.bytes === bytes.byteLength && prior.sha256 === digest) {
        s.lowestMissingSeq = this.binaryLowestMissing(s.lowestMissingSeq ?? 0);
        if (s.phase === "receiving") await this.armAlarm(s);
        const terminal = s.phase === "done" ? AckFlag.RunTerminal : 0;
        return this.binaryAck(
          frame,
          AckStatus.Duplicate,
          AckFlag.Accepted | AckFlag.Duplicate | terminal,
          AckDetail.None,
          200,
          s.lowestMissingSeq,
        );
      }
      return this.binaryAck(
        frame,
        AckStatus.SequenceConflict,
        0,
        AckDetail.None,
        409,
        this.binaryLowestMissing(s.lowestMissingSeq ?? 0),
      );
    }

    const declaredLost = this.ctx.storage.sql
      .exec<{ frame_seq: number }>(
        `SELECT frame_seq FROM binary_frames
          WHERE gap_first_frame IS NOT NULL AND gap_frame_count IS NOT NULL
            AND gap_first_frame != 4294967295 AND gap_frame_count != 4294967295
            AND ? >= gap_first_frame AND ? < gap_first_frame + gap_frame_count
          LIMIT 1`,
        frame.header.frameSeq,
        frame.header.frameSeq,
      )
      .toArray()[0];
    if (declaredLost) {
      return this.binaryAck(
        frame,
        AckStatus.SequenceConflict,
        0,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
      );
    }

    if (s.phase === "done" || (s.endSeq !== undefined && frame.header.frameSeq > s.endSeq)) {
      return this.binaryAck(
        frame,
        AckStatus.RunFinalized,
        AckFlag.RunTerminal,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
      );
    }
    if (s.phase === "finalizing") {
      return this.binaryAck(
        frame,
        AckStatus.Busy,
        AckFlag.Retryable,
        AckDetail.None,
        503,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
        5000,
      );
    }
    if (this.rateLimited()) {
      return this.binaryAck(
        frame,
        AckStatus.RateLimited,
        AckFlag.Retryable,
        AckDetail.None,
        429,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
        1000,
      );
    }
    if (frame.header.type === FrameType.Begin && frame.header.frameSeq !== 0) {
      return this.binaryAck(
        frame,
        AckStatus.ProtocolFormatConflict,
        0,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? 0,
      );
    }

    let schema: BinarySchema | null = null;
    let schemaPayloadDigest = "";
    let anchorId: number | null = null;
    let anchorPayloadDigest = "";
    let gapFirstFrame: number | null = null;
    let gapFrameCount: number | null = null;
    let sampleFirstSeq: number | null = null;
    let sampleLastSeq: number | null = null;
    let sampleFirstMono: string | null = null;
    let sampleLastMono: string | null = null;
    let timeFirstMono: string | null = null;
    let timeLastMono: string | null = null;
    let projectionCandidate: ProjectionAnchorState | undefined;
    let anchorQuality: number | null = null;
    let anchorMonotonicUs: string | null = null;
    let anchorUtcNs: string | null = null;
    let endPayload: ReturnType<typeof parseEnd> | null = null;
    try {
      if (frame.header.type === FrameType.Schema) {
        schema = parseSchema(frame.payload);
        schemaPayloadDigest = await sha256Bytes(frame.payload);
        const sameKey = this.ctx.storage.sql
          .exec<{ channel: string; frame_seq: number; payload_sha256: string }>(
            `SELECT channel, frame_seq, payload_sha256 FROM binary_schemas
              WHERE schema_id = ? AND revision = ?`,
            schema.id,
            schema.revision,
          )
          .toArray()[0];
        const sameId = this.ctx.storage.sql
          .exec<{ channel: string }>(
            "SELECT channel FROM binary_schemas WHERE schema_id = ? LIMIT 1",
            schema.id,
          )
          .toArray()[0];
        if (
          sameKey ||
          (sameId && sameId.channel !== schema.channel)
        ) {
          return this.binaryAck(
            frame,
            AckStatus.SchemaConflict,
            0,
            AckDetail.None,
            409,
            s.lowestMissingSeq ?? 0,
          );
        }
      } else if (frame.header.type === FrameType.Samples) {
        const lowestBefore = this.binaryLowestMissing(s.lowestMissingSeq ?? 0);
        if (lowestBefore !== frame.header.frameSeq) {
          return this.binaryAck(
            frame,
            AckStatus.Busy,
            AckFlag.Retryable,
            AckDetail.None,
            503,
            lowestBefore,
            1000,
          );
        }
        const schemas = this.loadBinarySchemas();
        const batch = parseSamples(
          frame.payload,
          (id, revision) => {
            const registered = schemas.get(`${id}/${revision}`);
            return registered && registered.frameSeq < frame.header.frameSeq
              ? registered.schema
              : undefined;
          },
        );
        const first = batch.samples[0]!;
        const last = batch.samples[batch.samples.length - 1]!;
        sampleFirstSeq = first.sampleSeq;
        sampleLastSeq = last.sampleSeq;
        sampleFirstMono = first.monotonicUs.toString();
        sampleLastMono = last.monotonicUs.toString();
        timeFirstMono = sampleFirstMono;
        timeLastMono = sampleLastMono;
        const expectedAnchor = this.ctx.storage.sql
          .exec<{ anchor_id: number }>(
            `SELECT anchor_id FROM binary_anchors
              WHERE frame_seq < ? ORDER BY frame_seq DESC LIMIT 1`,
            frame.header.frameSeq,
          )
          .toArray()[0]?.anchor_id ?? 0;
        for (const sample of batch.samples) {
          if (sample.anchorId !== expectedAnchor) {
            throw new Error(`invalid anchor ${sample.anchorId}; expected ${expectedAnchor}`);
          }
        }
      } else if (frame.header.type === FrameType.ClockAnchor) {
        const anchor = parseClockAnchor(frame.payload);
        anchorId = anchor.id;
        anchorPayloadDigest = await sha256Bytes(frame.payload);
        anchorQuality = anchor.quality;
        anchorMonotonicUs = anchor.monotonicUs.toString();
        anchorUtcNs = anchor.utcNs.toString();
        timeFirstMono = anchor.monotonicUs.toString();
        timeLastMono = timeFirstMono;
        projectionCandidate = {
          frameSeq: frame.header.frameSeq,
          id: anchor.id,
          quality: anchor.quality,
          monotonicUs: timeFirstMono,
          utcNs: anchor.utcNs.toString(),
        };
        const priorAnchor = this.ctx.storage.sql
          .exec<{ frame_seq: number; payload_sha256: string }>(
            "SELECT frame_seq, payload_sha256 FROM binary_anchors WHERE anchor_id = ?",
            anchor.id,
          )
          .toArray()[0];
        if (priorAnchor) {
          return this.binaryAck(
            frame,
            AckStatus.ProtocolFormatConflict,
            0,
            AckDetail.None,
            409,
            s.lowestMissingSeq ?? 0,
          );
        }
      } else if (frame.header.type === FrameType.Gap) {
        const gap = parseGap(frame.payload);
        timeFirstMono = gap.monotonicStartUs.toString();
        timeLastMono = gap.monotonicEndUs.toString();
        if (
          gap.firstLostFrameSeq !== 0xffffffff &&
          gap.lostFrameCount !== 0xffffffff &&
          gap.lostFrameCount > 0
        ) {
          const end = gap.firstLostFrameSeq + gap.lostFrameCount;
          if (end > 0x1_0000_0000 || end > frame.header.frameSeq) {
            return this.binaryAck(
              frame,
              AckStatus.ProtocolFormatConflict,
              0,
              AckDetail.None,
              409,
              s.lowestMissingSeq ?? 0,
            );
          }
          const overlaps = this.ctx.storage.sql
            .exec<{ frame_seq: number }>(
              `SELECT frame_seq FROM binary_frames
                WHERE frame_seq >= ? AND frame_seq < ? LIMIT 1`,
              gap.firstLostFrameSeq,
              end,
            )
            .toArray()[0];
          if (overlaps) {
            return this.binaryAck(
              frame,
              AckStatus.SequenceConflict,
              0,
              AckDetail.None,
              409,
              s.lowestMissingSeq ?? 0,
            );
          }
          gapFirstFrame = gap.firstLostFrameSeq;
          gapFrameCount = gap.lostFrameCount;
        }
      } else if (frame.header.type === FrameType.End) {
        endPayload = parseEnd(frame.payload);
        if (s.endSeq !== undefined && s.endSeq !== frame.header.frameSeq) {
          return this.binaryAck(
            frame,
            AckStatus.SequenceConflict,
            0,
            AckDetail.None,
            409,
            s.lowestMissingSeq ?? 0,
          );
        }
      }
    } catch (error) {
      const unknownSchema = error instanceof Error && error.message.startsWith("unknown schema ");
      return this.binaryAck(
        frame,
        unknownSchema
          ? AckStatus.UnknownSchema
          : frame.header.type === FrameType.Samples
            ? AckStatus.InvalidSample
            : AckStatus.ProtocolFormatConflict,
        0,
        AckDetail.None,
        400,
        s.lowestMissingSeq ?? 0,
      );
    }

    let nextMinimumMonoUs = s.binaryMinimumMonoUs;
    let nextMaximumMonoUs = s.binaryMaximumMonoUs;
    if (timeFirstMono !== null && timeLastMono !== null) {
      if (nextMinimumMonoUs === undefined || BigInt(timeFirstMono) < BigInt(nextMinimumMonoUs)) {
        nextMinimumMonoUs = timeFirstMono;
      }
      if (nextMaximumMonoUs === undefined || BigInt(timeLastMono) > BigInt(nextMaximumMonoUs)) {
        nextMaximumMonoUs = timeLastMono;
      }
    }
    const nextProjectionAnchor = projectionCandidate
      ? chooseProjectionAnchor(s.binaryProjectionAnchor, projectionCandidate)
      : s.binaryProjectionAnchor;
    try {
      validateProjectedBounds(nextMinimumMonoUs, nextMaximumMonoUs, nextProjectionAnchor);
    } catch {
      return this.binaryAck(
        frame,
        frame.header.type === FrameType.Samples
          ? AckStatus.InvalidSample
          : AckStatus.ProtocolFormatConflict,
        0,
        AckDetail.None,
        400,
        s.lowestMissingSeq ?? 0,
      );
    }

    // All cross-frame semantics are decided from the last committed SQLite snapshot. No durable
    // frame claim exists yet, so a crash or rejected frame can never become a false DUPLICATE.
    if (timeFirstMono !== null && timeLastMono !== null) {
      type Boundary = {
        sample_first_seq: number | null;
        sample_last_seq: number | null;
        time_first_mono: string;
        time_last_mono: string;
      };
      const predecessor = this.ctx.storage.sql
        .exec<Boundary>(
          `SELECT sample_first_seq, sample_last_seq, time_first_mono, time_last_mono
             FROM binary_frames
            WHERE frame_type = ? AND frame_seq < ?
            ORDER BY frame_seq DESC LIMIT 1`,
          frame.header.type,
          frame.header.frameSeq,
        )
        .toArray()[0];
      const successor = this.ctx.storage.sql
        .exec<Boundary>(
          `SELECT sample_first_seq, sample_last_seq, time_first_mono, time_last_mono
             FROM binary_frames
            WHERE frame_type = ? AND frame_seq > ?
            ORDER BY frame_seq ASC LIMIT 1`,
          frame.header.type,
          frame.header.frameSeq,
        )
        .toArray()[0];
      const followsPredecessor =
        !predecessor ||
        (frame.header.type === FrameType.Samples
          ? sampleRangeBefore(
              predecessor.time_last_mono,
              predecessor.sample_last_seq!,
              timeFirstMono,
              sampleFirstSeq!,
            )
          : BigInt(predecessor.time_last_mono) <= BigInt(timeFirstMono));
      const precedesSuccessor =
        !successor ||
        (frame.header.type === FrameType.Samples
          ? sampleRangeBefore(
              timeLastMono,
              sampleLastSeq!,
              successor.time_first_mono,
              successor.sample_first_seq!,
            )
          : BigInt(timeLastMono) <= BigInt(successor.time_first_mono));
      if (!followsPredecessor || !precedesSuccessor) {
        return this.binaryAck(
          frame,
          frame.header.type === FrameType.Samples
            ? AckStatus.InvalidSample
            : AckStatus.ProtocolFormatConflict,
          0,
          AckDetail.None,
          409,
          s.lowestMissingSeq ?? this.binaryLowestMissing(),
        );
      }
    }

    const existingEnd = this.ctx.storage.sql
      .exec<{ frame_seq: number }>(
        "SELECT frame_seq FROM binary_frames WHERE frame_type = ? LIMIT 1",
        FrameType.End,
      )
      .toArray()[0];
    if (
      (frame.header.type === FrameType.End &&
        (existingEnd !== undefined ||
          this.ctx.storage.sql
            .exec<{ frame_seq: number }>(
              "SELECT frame_seq FROM binary_frames WHERE frame_seq > ? LIMIT 1",
              frame.header.frameSeq,
            )
            .toArray().length > 0)) ||
      (frame.header.type !== FrameType.End &&
        existingEnd !== undefined &&
        frame.header.frameSeq > existingEnd.frame_seq)
    ) {
      return this.binaryAck(
        frame,
        frame.header.type === FrameType.End
          ? AckStatus.SequenceConflict
          : AckStatus.RunFinalized,
        frame.header.type === FrameType.End ? 0 : AckFlag.RunTerminal,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
      );
    }

    if (schema !== null) {
      const schemaCount = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM binary_schemas")
        .toArray()[0]!.count;
      if (schemaCount >= MAX_BINARY_SCHEMA_REVISIONS) {
        return this.binaryAck(
          frame,
          AckStatus.ProtocolFormatConflict,
          0,
          AckDetail.None,
          409,
          s.lowestMissingSeq ?? this.binaryLowestMissing(),
        );
      }
    }

    if (anchorId !== null) {
      const predecessor = this.ctx.storage.sql
        .exec<{ anchor_id: number }>(
          `SELECT anchor_id FROM binary_anchors WHERE frame_seq < ?
             ORDER BY frame_seq DESC LIMIT 1`,
          frame.header.frameSeq,
        )
        .toArray()[0];
      const successor = this.ctx.storage.sql
        .exec<{ anchor_id: number }>(
          `SELECT anchor_id FROM binary_anchors WHERE frame_seq > ?
             ORDER BY frame_seq ASC LIMIT 1`,
          frame.header.frameSeq,
        )
        .toArray()[0];
      if (
        (predecessor && predecessor.anchor_id >= anchorId) ||
        (successor && anchorId >= successor.anchor_id)
      ) {
        return this.binaryAck(
          frame,
          AckStatus.ProtocolFormatConflict,
          0,
          AckDetail.None,
          409,
          s.lowestMissingSeq ?? this.binaryLowestMissing(),
        );
      }
    }

    type CounterRow = {
      dropped_samples: number;
      dropped_frames: number;
      corrupt_frames: number;
      backpressure_events: number;
      retry_attempts: number;
    };
    const counterColumns = [
      "dropped_samples",
      "dropped_frames",
      "corrupt_frames",
      "backpressure_events",
      "retry_attempts",
    ] as const;
    const candidateCounters: CounterRow = {
      dropped_samples: frame.header.droppedSamples,
      dropped_frames: frame.header.droppedFrames,
      corrupt_frames: frame.header.corruptFrames,
      backpressure_events: frame.header.backpressureEvents,
      retry_attempts: frame.header.retryCount,
    };
    const counterPredecessor = this.ctx.storage.sql
      .exec<CounterRow>(
        `SELECT dropped_samples, dropped_frames, corrupt_frames,
                backpressure_events, retry_attempts
           FROM binary_frames WHERE frame_seq < ? ORDER BY frame_seq DESC LIMIT 1`,
        frame.header.frameSeq,
      )
      .toArray()[0];
    const counterSuccessor = this.ctx.storage.sql
      .exec<CounterRow>(
        `SELECT dropped_samples, dropped_frames, corrupt_frames,
                backpressure_events, retry_attempts
           FROM binary_frames WHERE frame_seq > ? ORDER BY frame_seq ASC LIMIT 1`,
        frame.header.frameSeq,
      )
      .toArray()[0];
    const countersOrdered = counterColumns.every(
      (column) =>
        (!counterPredecessor || counterPredecessor[column] <= candidateCounters[column]) &&
        (!counterSuccessor || candidateCounters[column] <= counterSuccessor[column]),
    );
    if (!countersOrdered) {
      return this.binaryAck(
        frame,
        AckStatus.ProtocolFormatConflict,
        0,
        AckDetail.None,
        409,
        s.lowestMissingSeq ?? this.binaryLowestMissing(),
      );
    }

    if (endPayload !== null) {
      const maximum = this.ctx.storage.sql
        .exec<CounterRow>(
          `SELECT COALESCE(MAX(dropped_samples), 0) AS dropped_samples,
                  COALESCE(MAX(dropped_frames), 0) AS dropped_frames,
                  COALESCE(MAX(corrupt_frames), 0) AS corrupt_frames,
                  COALESCE(MAX(backpressure_events), 0) AS backpressure_events,
                  COALESCE(MAX(retry_attempts), 0) AS retry_attempts
             FROM binary_frames`,
        )
        .toArray()[0]!;
      if (
        endPayload.attemptedSamples < endPayload.encodedSamples ||
        endPayload.encodedSamples + endPayload.droppedSamples > endPayload.attemptedSamples ||
        endPayload.droppedSamples !== frame.header.droppedSamples ||
        endPayload.droppedFrames !== frame.header.droppedFrames ||
        endPayload.corruptFrames !== frame.header.corruptFrames ||
        endPayload.backpressureEvents !== frame.header.backpressureEvents ||
        endPayload.retryAttempts !== frame.header.retryCount ||
        counterColumns.some((column) => candidateCounters[column] < maximum[column])
      ) {
        return this.binaryAck(
          frame,
          AckStatus.ProtocolFormatConflict,
          0,
          AckDetail.None,
          409,
          s.lowestMissingSeq ?? this.binaryLowestMissing(),
        );
      }
    }

    // R2 is deliberately first and content-addressed. If the object dies here, the only residue is
    // an unreferenced immutable body. A retry has no SQL claim to mistake for a committed frame.
    const r2key = `${this.stagePrefix(s)}frames/${String(frame.header.frameSeq).padStart(10, "0")}-${digest}.bin`;
    try {
      await this.stageBinaryFrame(r2key, bytes);
    } catch {
      return this.binaryAck(
        frame,
        AckStatus.InternalError,
        AckFlag.Retryable,
        AckDetail.None,
        503,
        s.lowestMissingSeq ?? 0,
        5000,
      );
    }

    s.binaryMinimumMonoUs = nextMinimumMonoUs;
    s.binaryMaximumMonoUs = nextMaximumMonoUs;
    s.binaryProjectionAnchor = nextProjectionAnchor;
    s.endSeq = frame.header.type === FrameType.End
      ? frame.header.frameSeq
      : existingEnd?.frame_seq;
    s.lastChunkAt = Date.now();

    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO binary_frames(
             frame_seq, frame_type, r2key, bytes, sha256, request_crc,
             dropped_samples, dropped_frames, corrupt_frames,
             backpressure_events, retry_attempts,
             gap_first_frame, gap_frame_count,
             sample_first_seq, sample_last_seq, sample_first_mono, sample_last_mono,
             time_first_mono, time_last_mono)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          frame.header.frameSeq,
          frame.header.type,
          r2key,
          bytes.byteLength,
          digest,
          frame.header.crc32c,
          frame.header.droppedSamples,
          frame.header.droppedFrames,
          frame.header.corruptFrames,
          frame.header.backpressureEvents,
          frame.header.retryCount,
          gapFirstFrame,
          gapFrameCount,
          sampleFirstSeq,
          sampleLastSeq,
          sampleFirstMono,
          sampleLastMono,
          timeFirstMono,
          timeLastMono,
        );
        if (schema !== null) {
          this.ctx.storage.sql.exec(
            `INSERT INTO binary_schemas(
               schema_id, revision, channel, frame_seq, payload_sha256, schema_json)
               VALUES (?, ?, ?, ?, ?, ?)`,
            schema.id,
            schema.revision,
            schema.channel,
            frame.header.frameSeq,
            schemaPayloadDigest,
            JSON.stringify(schema),
          );
        }
        if (
          anchorId !== null &&
          anchorQuality !== null &&
          anchorMonotonicUs !== null &&
          anchorUtcNs !== null
        ) {
          this.ctx.storage.sql.exec(
            `INSERT INTO binary_anchors(
               anchor_id, frame_seq, payload_sha256, quality, monotonic_us, utc_ns)
               VALUES (?, ?, ?, ?, ?, ?)`,
            anchorId,
            frame.header.frameSeq,
            anchorPayloadDigest,
            anchorQuality,
            anchorMonotonicUs,
            anchorUtcNs,
          );
        }
        s.lowestMissingSeq = this.binaryLowestMissing(s.lowestMissingSeq ?? 0);
        if (s.endSeq !== undefined && s.lowestMissingSeq > s.endSeq) {
          s.phase = "finalizing";
        }
        this.writeBinaryState(s);
      });
    } catch {
      await this.env.STAGING.delete(r2key).catch(() => {});
      return this.binaryAck(
        frame,
        AckStatus.InternalError,
        AckFlag.Retryable,
        AckDetail.None,
        503,
        this.binaryLowestMissing(s.lowestMissingSeq ?? 0),
        5000,
      );
    }

    const runComplete = s.endSeq !== undefined &&
      (s.lowestMissingSeq ?? this.binaryLowestMissing()) > s.endSeq;
    await this.ctx.storage.setAlarm(
      runComplete
        ? Date.now()
        : Date.now() + (s.inactivityMs || Number(this.env.INACTIVITY_MS)),
    );
    return this.binaryAck(
      frame,
      AckStatus.Accepted,
      AckFlag.Accepted,
      AckDetail.None,
      200,
      s.lowestMissingSeq ?? this.binaryLowestMissing(),
    );
  }

  private rateLimited(): boolean {
    const now = Date.now();
    this.recentChunks = this.recentChunks.filter((t) => now - t < 60_000);
    if (this.recentChunks.length >= RATE_LIMIT_PER_MIN) return true;
    this.recentChunks.push(now);
    return false;
  }

  private async armAlarm(s: State): Promise<void> {
    s.lastChunkAt = Date.now();
    if (s.format === "binary") {
      this.ctx.storage.transactionSync(() => this.writeBinaryState(s));
    } else {
      await this.ctx.storage.put("state", s);
    }
    await this.ctx.storage.setAlarm(
      Date.now() + (s.inactivityMs || Number(this.env.INACTIVITY_MS)),
    );
  }

  private async onChunk(req: Request, s: State): Promise<Response> {
    if (this.rateLimited()) return new Response("rate limited", { status: 429 });
    const channel = req.headers.get("X-Alloy-Channel")!;
    const seq = Number(req.headers.get("X-Alloy-Seq"));

    const dup = this.ctx.storage.sql
      .exec("SELECT 1 FROM chunks WHERE channel = ? AND seq = ?", channel, seq)
      .toArray();
    if (dup.length > 0) {
      await this.armAlarm(s); // a retry still proves the device is alive
      return new Response(null, { status: 204 });
    }

    const body = new Uint8Array(await req.arrayBuffer());
    const r2key = `${this.stagePrefix(s)}${channel}/${String(seq).padStart(10, "0")}.csv`;
    await this.env.STAGING.put(r2key, body);
    this.ctx.storage.sql.exec(
      "INSERT INTO chunks(channel, seq, r2key, bytes) VALUES (?, ?, ?, ?)",
      channel,
      seq,
      r2key,
      body.byteLength,
    );
    await this.armAlarm(s);
    return new Response(null, { status: 204 });
  }

  private async onMeta(req: Request, s: State): Promise<Response> {
    const body = new Uint8Array(await req.arrayBuffer());
    await this.env.STAGING.put(`${this.stagePrefix(s)}_meta.json`, body); // idempotent overwrite
    await this.armAlarm(s);
    return new Response(null, { status: 204 });
  }

  private async onEnd(s: State): Promise<Response> {
    s.phase = "finalizing";
    await this.ctx.storage.put("state", s);
    await this.ctx.storage.setAlarm(Date.now()); // run finalize from the alarm handler, not the request
    return new Response(null, { status: 202 });
  }

  alarm(): Promise<void> {
    return this.withBinaryLock(() => this.onAlarm());
  }

  private async onAlarm(): Promise<void> {
    const s = await this.state();
    if (!s || s.phase === "done" || s.phase === "failed") return;

    if (s.phase === "receiving") {
      // an alarm only ever fires INACTIVITY_MS after the last armAlarm(), so the run is over
      s.phase = "finalizing";
      if (s.format === "binary") {
        this.ctx.storage.transactionSync(() => this.writeBinaryState(s));
      } else {
        await this.ctx.storage.put("state", s);
      }
    }

    try {
      await this.finalize(s);
    } catch (err) {
      s.finalizeAttempts++;
      console.error(
        `finalize failed (attempt ${s.finalizeAttempts}) device=${s.device} session=${s.session}: ${err}`,
      );
      if (s.finalizeAttempts < MAX_FINALIZE_ATTEMPTS) {
        if (s.format === "binary") {
          this.ctx.storage.transactionSync(() => this.writeBinaryState(s));
        } else {
          await this.ctx.storage.put("state", s);
        }
        const backoffMin = Math.min(2 ** s.finalizeAttempts, 60);
        await this.ctx.storage.setAlarm(Date.now() + backoffMin * 60_000);
      } else if (s.format === "binary") {
        s.phase = "failed";
        s.apiKey = "";
        s.failure = "finalize_exhausted";
        s.failedAt = Date.now();
        this.ctx.storage.transactionSync(() => this.writeBinaryState(s));
        await this.ctx.storage.deleteAlarm();
      } else {
        // Keep legacy v1 exhaustion behavior unchanged.
        await this.ctx.storage.put("state", s);
      }
    }
  }

  private async finalize(s: State): Promise<void> {
    if (s.format === "binary") return this.finalizeBinary(s);

    const rows = this.ctx.storage.sql
      .exec<{ channel: string; seq: number; r2key: string; bytes: number }>(
        "SELECT channel, seq, r2key, bytes FROM chunks ORDER BY channel, seq",
      )
      .toArray();
    if (rows.length === 0) {
      await this.markDone(s, 0); // nothing ever arrived (meta-only session) — just close out
      return;
    }

    // group by channel; rows are already seq-ordered within each channel
    const byChannel = new Map<string, { r2key: string }[]>();
    for (const r of rows) {
      let list = byChannel.get(r.channel);
      if (!list) byChannel.set(r.channel, (list = []));
      list.push({ r2key: r.r2key });
    }
    const staging = this.env.STAGING;
    const sources: ChunkSource[] = [...byChannel.entries()].map(([channel, refs]) => ({
      channel,
      chunks: async function* () {
        for (const ref of refs) {
          const obj = await staging.get(ref.r2key);
          if (!obj) throw new Error(`staged chunk missing: ${ref.r2key}`);
          yield new Uint8Array(await obj.arrayBuffer());
        }
      },
    }));

    const metaObj = await staging.get(`${this.stagePrefix(s)}_meta.json`);
    let meta: DeviceMeta | null = null;
    let metaBytes: Uint8Array | null = null;
    if (metaObj) {
      metaBytes = new Uint8Array(await metaObj.arrayBuffer());
      try {
        meta = JSON.parse(new TextDecoder().decode(metaBytes)) as DeviceMeta;
      } catch {
        meta = null; // corrupt sidecar — assemble without semantics rather than fail the run
      }
    }

    const mcap = (await assembleMcap(sources, meta, {
      device: s.device,
      session: s.session,
      meshPath: s.meshPath,
    }))!;

    if (this.env.DRY_RUN !== "1") {
      const sess = await mintUploadSession(
        this.env.ALLOY_DATA_URL,
        s.apiKey,
        `${s.meshPath}/${s.session}`,
      );
      if (!sess) throw new Error("upload-session mint failed at finalize");
      if (!(await putToMesh(sess, `${s.device}_${s.session}.mcap`, mcap, "application/octet-stream"))) {
        throw new Error("mcap PUT failed");
      }
      if (metaBytes) {
        // best-effort: the semantics sidecar helps Alloy AI but must not fail the run
        await putToMesh(sess, `${s.device}_meta.json`, metaBytes, "application/json").catch(() => {});
      }
    }

    await this.markDone(s, mcap.byteLength);
  }

  private async finalizeBinary(s: State): Promise<void> {
    const bounds = this.ctx.storage.sql
      .exec<{ count: number; maximum: number | null }>(
        "SELECT COUNT(*) AS count, MAX(frame_seq) AS maximum FROM binary_frames",
      )
      .toArray()[0]!;
    if (bounds.count === 0 || bounds.maximum === null) {
      await this.markDone(s, 0);
      return;
    }

    const sql = this.ctx.storage.sql;
    const staging = this.env.STAGING;
    const source = {
      frames: async function* () {
        let after = -1;
        for (;;) {
          // Page only compact SQL references; each R2 object is fetched, yielded, and released
          // before the next object. assembleBinaryMcap may replay this generator for later passes.
          const page = sql
            .exec<{ frame_seq: number; r2key: string }>(
              `SELECT frame_seq, r2key FROM binary_frames
                WHERE frame_seq > ? ORDER BY frame_seq LIMIT 64`,
              after,
            )
            .toArray();
          if (page.length === 0) return;
          for (const row of page) {
            const obj = await staging.get(row.r2key);
            if (!obj) throw new Error(`staged binary frame missing: ${row.r2key}`);
            yield { seq: row.frame_seq, bytes: new Uint8Array(await obj.arrayBuffer()) };
            after = row.frame_seq;
          }
        }
      },
    };
    const lowestMissing = this.binaryLowestMissing(s.lowestMissingSeq ?? 0);
    const mcap = (await assembleBinaryMcap(source, {
      device: s.device,
      session: s.session,
      meshPath: s.meshPath,
      sequenceComplete: lowestMissing > bounds.maximum,
    }))!;

    if (this.env.DRY_RUN !== "1") {
      const sess = await mintUploadSession(
        this.env.ALLOY_DATA_URL,
        s.apiKey,
        `${s.meshPath}/${s.session}`,
      );
      if (!sess) throw new Error("upload-session mint failed at binary finalize");
      if (!(await putToMesh(sess, `${s.device}_${s.session}.mcap`, mcap, "application/octet-stream"))) {
        throw new Error("binary mcap PUT failed");
      }
    }

    await this.markDone(s, mcap.byteLength);
    console.log(
      `binary finalize complete device=${s.device} run=${s.session} mcapBytes=${mcap.byteLength}`,
    );
  }

  private async markDone(s: State, mcapBytes: number): Promise<void> {
    const doneState: State = {
      ...s,
      apiKey: "",
      phase: "done",
    };
    const tombstone = {
      device: s.device,
      session: s.session,
      meshPath: s.meshPath,
      format: s.format ?? "csv",
      mcapBytes,
      finalizedAt: Date.now(),
    };

    if (s.format === "binary") {
      // Publish the durable terminal state before cleanup. If the instance dies after the remote
      // deterministic PUT, a retry sees `done`; leftover staging objects are harmless and covered
      // by the bucket lifecycle instead of making finalization permanently unreplayable.
      this.ctx.storage.transactionSync(() => {
        this.writeBinaryState(doneState);
        this.ctx.storage.sql.exec(
          `INSERT INTO binary_tombstone(singleton, tombstone_json) VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET tombstone_json = excluded.tombstone_json`,
          JSON.stringify(tombstone),
        );
      });
      await this.ctx.storage.deleteAlarm();
      try {
        let after = -1;
        for (;;) {
          const page = this.ctx.storage.sql
            .exec<{ frame_seq: number; r2key: string }>(
              `SELECT frame_seq, r2key FROM binary_frames
                WHERE frame_seq > ? ORDER BY frame_seq LIMIT 1000`,
              after,
            )
            .toArray();
          if (page.length === 0) break;
          await this.env.STAGING.delete(page.map((row) => row.r2key));
          after = page[page.length - 1]!.frame_seq;
        }
      } catch (error) {
        console.warn(
          `binary staging cleanup deferred device=${s.device} run=${s.session}: ${String(error)}`,
        );
      }
      // Retain the compact frame hashes/lengths so an exact retry can still receive a DUPLICATE
      // ACK after finalization. The R2 bodies are gone; divergent same-seq retries remain conflicts.
      return;
    }

    // Preserve the legacy CSV cleanup/terminal ordering exactly.
    const keys = this.ctx.storage.sql
      .exec<{ r2key: string }>("SELECT r2key FROM chunks")
      .toArray()
      .map((r) => r.r2key);
    keys.push(`${this.stagePrefix(s)}_meta.json`);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.env.STAGING.delete(keys.slice(i, i + 1000));
    }
    this.ctx.storage.sql.exec("DELETE FROM chunks");
    await this.ctx.storage.put<unknown>({ state: doneState, tombstone });
    await this.ctx.storage.deleteAlarm();
  }
}
