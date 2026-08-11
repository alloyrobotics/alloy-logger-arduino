// Integration tests: Worker routing/auth + SessionDO state machine, against mocked Alloy
// endpoints (upload-session + R2 PUT) so the FULL finalize path runs, SigV4 signing included.

import { beforeEach, describe, expect, it } from "vitest";
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { McapIndexedReader, type IReadable } from "@mcap/core";
import { AckDetail, AckFlag, AckStatus, FrameType, crc32c } from "../src/binary";
import {
  anchorPayload,
  beginPayload,
  endPayload,
  gapPayload,
  makeFrame,
  samplesPayload,
  schemaPayload,
} from "./wire-fixture";

const GOOD_KEY = "test-key-good";
const BAD_KEY = "test-key-bad";
const DEVICE = "esp32-abc123";
const MESH = "robots/test";
// storage is shared across tests within this file — a unique session per test
// keeps DO instances and staging keys from colliding
let sessionCounter = 1782000000;
let SESSION = "";

const uploadSessionBody = () => ({
  bucket: "test-bucket",
  endpoint_url: "https://r2.mock",
  region: "auto",
  prefix: `uploads/sdk-uploads/${MESH}/${SESSION}/`,
  expires_at: "2099-01-01T00:00:00Z",
  credentials: {
    access_key_id: "AKIATEST",
    secret_access_key: "secret",
    session_token: "token",
  },
});

// PUTs into the mocked mesh, keyed by path — lets tests assert what landed
let meshPuts: string[] = [];
let meshBodies = new Map<string, Uint8Array>();

// the mock fetch persists across tests, so it is installed once and consults
// module-level knobs (fetchMock was removed in vitest-pool-workers 0.13; the main
// worker + DO run in the same isolate as tests, so patching globalThis.fetch applies)
let failsLeft = 0;
let mocksRegistered = false;

function mockAlloy(opts: { failPuts?: number } = {}) {
  failsLeft = opts.failPuts ?? 0;
  if (mocksRegistered) return;
  mocksRegistered = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === "https://alloy.mock") {
      if (url.pathname === "/mesh/storage/upload-session" && req.method === "POST") {
        if (req.headers.get("Authorization") === `Bearer ${GOOD_KEY}`) {
          return Response.json(uploadSessionBody());
        }
        return new Response("forbidden", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    }
    if (url.origin === "https://r2.mock" && req.method === "PUT") {
      if (failsLeft > 0) {
        failsLeft--;
        return new Response("injected failure", { status: 500 });
      }
      meshPuts.push(url.pathname);
      meshBodies.set(url.pathname, new Uint8Array(await req.arrayBuffer()));
      return new Response("", { status: 200 });
    }
    throw new Error(`unmocked outbound fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
}

function post(
  path: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`https://ingest.alloylogger.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GOOD_KEY}`,
      "X-Alloy-Device": DEVICE,
      "X-Alloy-Session": SESSION,
      "X-Alloy-Mesh-Path": MESH,
      ...headers,
    },
    body,
  });
}

function chunk(channel: string, seq: number, csv: string): Promise<Response> {
  return post("/v1/chunk", csv, {
    "X-Alloy-Channel": channel,
    "X-Alloy-Seq": String(seq),
    "Content-Type": "text/csv",
  });
}

function currentRunId(): Uint8Array {
  return Uint8Array.from(SESSION.match(/../g)!.map((hex) => Number.parseInt(hex, 16)));
}

function useBinaryRun(): void {
  SESSION = BigInt(SESSION).toString(16).padStart(32, "0");
}

function binaryFrame(
  type: FrameType,
  payload: Uint8Array,
  seq: number,
  options: {
    droppedSamples?: number;
    droppedFrames?: number;
    corruptFrames?: number;
    backpressureEvents?: number;
    retryAttempts?: number;
  } = {},
): Uint8Array {
  return makeFrame(type, payload, {
    seq,
    runId: currentRunId(),
    ...options,
  });
}

function postBinary(
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch("https://ingest.alloylogger.com/v2/frame", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GOOD_KEY}`,
      "X-Alloy-Device": DEVICE,
      "X-Alloy-Run": SESSION,
      "X-Alloy-Mesh-Path": MESH,
      "Content-Type": "application/vnd.alloy.frame;version=1",
      ...headers,
    },
    body,
  });
}

async function readAck(res: Response): Promise<{
  status: number;
  flags: number;
  detail: number;
  ackSeq: number;
  lowestMissing: number;
  echoCrc: number;
}> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes).toHaveLength(48);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("ALYA");
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(40, true)).toBe(crc32c(bytes, 40, 4));
  return {
    status: bytes[5]!,
    flags: view.getUint16(6, true),
    detail: view.getUint16(10, true),
    ackSeq: view.getUint32(12, true),
    lowestMissing: view.getUint32(16, true),
    echoCrc: view.getUint32(44, true),
  };
}

interface StoredState {
  phase: string;
  finalizeAttempts: number;
  apiKey: string;
  failure?: string;
}

class BufferReadable implements IReadable {
  constructor(private readonly bytes: Uint8Array) {}
  size(): Promise<bigint> {
    return Promise.resolve(BigInt(this.bytes.byteLength));
  }
  read(offset: bigint, size: bigint): Promise<Uint8Array> {
    return Promise.resolve(
      this.bytes.subarray(Number(offset), Number(offset + size)),
    );
  }
}

async function storedState(
  stub?: Awaited<ReturnType<typeof sessionStub>>,
): Promise<StoredState | undefined> {
  const target = stub ?? await sessionStub();
  return runInDurableObject(target, async (_i: unknown, state: DurableObjectState) => {
    const binary = state.storage.sql
      .exec<{ state_json: string }>(
        "SELECT state_json FROM binary_session WHERE singleton = 1",
      )
      .toArray()[0];
    return binary
      ? JSON.parse(binary.state_json) as StoredState
      : state.storage.get<StoredState>("state");
  });
}

// /v1/end schedules setAlarm(now) and workerd auto-fires it in the background, so tests must
// await the resulting state rather than fire the alarm themselves.
async function waitForState(
  pred: (st: StoredState) => boolean,
  ms = 3000,
): Promise<StoredState> {
  const stub = await sessionStub();
  const t0 = Date.now();
  for (;;) {
    const st = await storedState(stub);
    if (st && pred(st)) return st;
    if (Date.now() - t0 > ms) {
      throw new Error(`timeout waiting for DO state, last: ${JSON.stringify(st)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function sessionStub() {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(GOOD_KEY),
  );
  const keyHash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const id = env.SESSION_DO.idFromName(`${keyHash}:${DEVICE}:${SESSION}`);
  return env.SESSION_DO.get(id);
}

async function failNextBinaryCommit(
  stub: Awaited<ReturnType<typeof sessionStub>>,
): Promise<void> {
  await runInDurableObject(stub, (instance: unknown) => {
    Reflect.set(
      instance as Record<string, unknown>,
      "nextBinaryStageFailureAfterPut",
      true,
    );
  });
}

async function delayNextStagingPut(
  stub: Awaited<ReturnType<typeof sessionStub>>,
): Promise<void> {
  await runInDurableObject(stub, (instance: unknown) => {
    const target = instance as Record<string, unknown>;
    Reflect.set(target, "nextBinaryStageDelayMs", 100);
  });
}

beforeEach(() => {
  SESSION = String(sessionCounter++);
  meshPuts = [];
  meshBodies = new Map();
});

describe("worker routing + auth", () => {
  it("health check", async () => {
    const res = await SELF.fetch("https://ingest.alloylogger.com/v1/health");
    expect(res.status).toBe(200);
  });

  it("rejects missing bearer", async () => {
    const res = await SELF.fetch("https://ingest.alloylogger.com/v1/chunk", {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid key via the Alloy auth oracle", async () => {
    mockAlloy();
    const res = await post("/v1/chunk", "t_ns,x\n0000000000000000001,1\n", {
      Authorization: `Bearer ${BAD_KEY}`,
      "X-Alloy-Channel": "io",
      "X-Alloy-Seq": "0",
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed headers", async () => {
    mockAlloy();
    expect(
      (await post("/v1/chunk", "x", { "X-Alloy-Channel": "bad channel!", "X-Alloy-Seq": "0" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/v1/chunk", "x", {
          "X-Alloy-Channel": "io",
          "X-Alloy-Seq": "0",
          "X-Alloy-Session": "not-digits",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects oversized chunks", async () => {
    mockAlloy();
    const res = await post("/v1/chunk", "x".repeat(70 * 1024), {
      "X-Alloy-Channel": "io",
      "X-Alloy-Seq": "0",
    });
    expect(res.status).toBe(413);
  });
});

describe("session lifecycle", () => {
  it("stages chunks, dedupes retries, finalizes on /v1/end, purges, then 409s", async () => {
    mockAlloy();
    expect((await chunk("io", 0, "t_ns,btn\n0000000000000000100,1\n")).status).toBe(204);
    expect((await chunk("io", 1, "t_ns,btn\n0000000000000000200,0\n")).status).toBe(204);
    expect((await chunk("io", 1, "t_ns,btn\n0000000000000000200,0\n")).status).toBe(204); // retry
    expect((await post("/v1/meta", JSON.stringify({ device: DEVICE, fields: [] }))).status).toBe(
      204,
    );

    // dedupe: exactly 2 staged chunk objects (+1 meta)
    const staged = await env.STAGING.list();
    const mine = staged.objects.filter((o: R2Object) => o.key.includes(`/${SESSION}/`));
    expect(mine.filter((o: R2Object) => o.key.endsWith(".csv")).length).toBe(2);

    expect((await post("/v1/end", null)).status).toBe(202);
    await runDurableObjectAlarm(await sessionStub()); // no-op if it already auto-fired
    await waitForState((st) => st.phase === "done");

    // one mcap + the meta sidecar landed in the (mocked) user mesh
    expect(meshPuts).toContainEqual(
      `/test-bucket/uploads/sdk-uploads/${MESH}/${SESSION}/${DEVICE}_${SESSION}.mcap`,
    );
    expect(meshPuts).toContainEqual(
      `/test-bucket/uploads/sdk-uploads/${MESH}/${SESSION}/${DEVICE}_meta.json`,
    );

    // staging purged, tombstone written, key gone
    const after = await env.STAGING.list();
    expect(after.objects.filter((o: R2Object) => o.key.includes(`/${SESSION}/`)).length).toBe(0);
    const stub = await sessionStub();
    const { tombstone, apiKey } = (await runInDurableObject(
      stub,
      async (_i: unknown, state: DurableObjectState) => ({
        tombstone: await state.storage.get("tombstone"),
        apiKey: ((await state.storage.get("state")) as { apiKey: string }).apiKey,
      }),
    )) as { tombstone: { mcapBytes: number }; apiKey: string };
    expect(tombstone.mcapBytes).toBeGreaterThan(0);
    expect(apiKey).toBe("");

    // late chunk → 409; late end → 204
    expect((await chunk("io", 2, "t_ns,btn\n0000000000000000300,1\n")).status).toBe(409);
    expect((await post("/v1/end", null)).status).toBe(204);
  });

  it("honors X-Alloy-Finalize-Ms (clamped) for the inactivity window", async () => {
    mockAlloy();
    await chunk("io", 0, "t_ns,btn\n0000000000000000100,1\n"); // no header → env default
    let st = (await runInDurableObject(
      await sessionStub(),
      (_i: unknown, state: DurableObjectState) => state.storage.get("state"),
    )) as { inactivityMs: number };
    expect(st.inactivityMs).toBe(600000);

    SESSION = String(sessionCounter++); // fresh session with an explicit 45s ask → clamped to 30s floor... 45s is above floor
    await post("/v1/chunk", "t_ns,btn\n0000000000000000100,1\n", {
      "X-Alloy-Channel": "io",
      "X-Alloy-Seq": "0",
      "X-Alloy-Finalize-Ms": "45000",
    });
    st = (await runInDurableObject(
      await sessionStub(),
      (_i: unknown, state: DurableObjectState) => state.storage.get("state"),
    )) as { inactivityMs: number };
    expect(st.inactivityMs).toBe(45000);

    SESSION = String(sessionCounter++); // below the 30s floor → clamped up
    await post("/v1/chunk", "t_ns,btn\n0000000000000000100,1\n", {
      "X-Alloy-Channel": "io",
      "X-Alloy-Seq": "0",
      "X-Alloy-Finalize-Ms": "1000",
    });
    st = (await runInDurableObject(
      await sessionStub(),
      (_i: unknown, state: DurableObjectState) => state.storage.get("state"),
    )) as { inactivityMs: number };
    expect(st.inactivityMs).toBe(30000);
  });

  it("finalizes on the inactivity alarm (power-loss path)", async () => {
    mockAlloy();
    await chunk("adc", 0, "t_ns,v\n0000000000000000100,3.3\n");
    const fired = await runDurableObjectAlarm(await sessionStub());
    expect(fired).toBe(true);
    expect(meshPuts.some((p) => p.endsWith(".mcap"))).toBe(true);
  });

  it("accepts out-of-order seqs and still assembles", async () => {
    mockAlloy();
    await chunk("io", 5, "t_ns,btn\n0000000000000000500,1\n");
    await chunk("io", 2, "t_ns,btn\n0000000000000000200,0\n");
    await post("/v1/end", null);
    await runDurableObjectAlarm(await sessionStub());
    await waitForState((st) => st.phase === "done");
    const stub = await sessionStub();
    const tomb = (await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) =>
      state.storage.get("tombstone"),
    )) as { mcapBytes: number };
    expect(tomb.mcapBytes).toBeGreaterThan(0);
  });

  it("retries finalize with backoff after an upstream failure, then succeeds", async () => {
    mockAlloy({ failPuts: 1 }); // first mesh PUT 500s
    await chunk("io", 0, "t_ns,btn\n0000000000000000100,1\n");
    await post("/v1/end", null);

    // attempt 1 auto-fires and fails against the injected 500; backoff alarm gets set
    const st = await waitForState((s) => s.finalizeAttempts === 1);
    expect(st.phase).toBe("finalizing");

    // chunks are refused mid-finalize
    expect((await chunk("io", 1, "t_ns,btn\n0000000000000000200,0\n")).status).toBe(503);

    // fast-forward the backoff alarm — retry succeeds
    const fired = await runDurableObjectAlarm(await sessionStub());
    expect(fired).toBe(true);
    await waitForState((s) => s.phase === "done");
    expect(meshPuts.some((p) => p.endsWith(".mcap"))).toBe(true);
  });
});

describe("Alloy Device Wire v1 ingest", () => {
  it("bounds the actual body, validates identity/CRC, and returns a protected ACK with server time", async () => {
    useBinaryRun();
    mockAlloy();

    const oversized = await postBinary(new Uint8Array(1025), { "Content-Length": "1" });
    expect(oversized.status).toBe(413);

    const mismatched = binaryFrame(
      FrameType.Begin,
      beginPayload({ device: DEVICE }),
      0,
    );
    const otherRun = "ffffffffffffffffffffffffffffffff";
    const identity = await postBinary(mismatched, { "X-Alloy-Run": otherRun });
    expect(identity.status).toBe(400);
    expect(await readAck(identity)).toMatchObject({ status: AckStatus.IdentityConflict });

    const corrupt = mismatched.slice();
    corrupt[corrupt.length - 1] ^= 1;
    const badCrc = await postBinary(corrupt);
    expect(badCrc.status).toBe(400);
    expect(await readAck(badCrc)).toMatchObject({ status: AckStatus.BadCrc });

    const frame = binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0);
    const res = await postBinary(frame);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.alloy.ack;version=1");
    expect(res.headers.get("X-Alloy-Server-UTC-Ns")).toMatch(/^\d{19}$/);
    const ack = await readAck(res);
    expect(ack).toMatchObject({
      status: AckStatus.Accepted,
      flags: AckFlag.Accepted,
      detail: AckDetail.None,
      ackSeq: 0,
      lowestMissing: 1,
      echoCrc: new DataView(frame.buffer).getUint32(60, true),
    });
  });

  it("rejects the reserved maximum frame and sample sequence before DO staging", async () => {
    useBinaryRun();
    mockAlloy();
    const maximumFrame = binaryFrame(
      FrameType.Begin,
      beginPayload({ device: DEVICE }),
      0xffff_ffff,
    );
    const frameResponse = await postBinary(maximumFrame);
    expect(frameResponse.status).toBe(400);
    expect(await readAck(frameResponse)).toMatchObject({
      status: AckStatus.ProtocolFormatConflict,
    });

    const maximumSample = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        rows: [
          {
            deltaUs: 0,
            sampleSeq: 0xffff_ffff,
            temp: 20,
            healthy: true,
          },
        ],
      }),
      1,
    );
    const sampleResponse = await postBinary(maximumSample);
    expect(sampleResponse.status).toBe(400);
    expect(await readAck(sampleResponse)).toMatchObject({ status: AckStatus.InvalidSample });
    const staged = await env.STAGING.list();
    expect(staged.objects.some((object: R2Object) => object.key.includes(`/${SESSION}/`))).toBe(
      false,
    );
  });

  it("accepts an exact duplicate, rejects a changed same-seq frame, and preserves the original", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    const original = binaryFrame(FrameType.Samples, samplesPayload(), 2);
    expect((await postBinary(original)).status).toBe(200);

    const duplicateResponse = await postBinary(original);
    expect(duplicateResponse.status).toBe(200);
    expect(await readAck(duplicateResponse)).toMatchObject({
      status: AckStatus.Duplicate,
      flags: AckFlag.Accepted | AckFlag.Duplicate,
      ackSeq: 2,
    });

    const changed = binaryFrame(
      FrameType.Samples,
      samplesPayload({ rows: [{ deltaUs: 0, sampleSeq: 1, temp: 99, healthy: false }] }),
      2,
    );
    const conflict = await postBinary(changed);
    expect(conflict.status).toBe(409);
    expect(await readAck(conflict)).toMatchObject({
      status: AckStatus.SequenceConflict,
      detail: AckDetail.None,
    });

    const staged = await env.STAGING.list();
    const object = staged.objects.find((item: R2Object) =>
      item.key.includes(`/${SESSION}/frames/0000000002-`),
    );
    expect(object).toBeDefined();
    const stored = await env.STAGING.get(object!.key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(original);
  });

  it("preserves one content-addressed winner under concurrent same-sequence conflicts", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    const candidates = [
      binaryFrame(
        FrameType.Samples,
        samplesPayload({ rows: [{ deltaUs: 0, sampleSeq: 1, temp: 10, healthy: true }] }),
        2,
      ),
      binaryFrame(
        FrameType.Samples,
        samplesPayload({ rows: [{ deltaUs: 0, sampleSeq: 1, temp: 20, healthy: false }] }),
        2,
      ),
    ];
    const responses = await Promise.all(candidates.map((candidate) => postBinary(candidate)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const acks = await Promise.all(responses.map((response) => readAck(response)));
    expect(acks.map((ack) => ack.status).sort((a, b) => a - b)).toEqual([
      AckStatus.Accepted,
      AckStatus.SequenceConflict,
    ]);
    const acceptedIndex = acks.findIndex((ack) => ack.status === AckStatus.Accepted);

    const staged = await env.STAGING.list();
    const winners = staged.objects.filter(
      (item: R2Object) =>
        item.key.includes(`/${SESSION}/frames/`) && item.key.includes("0000000002-"),
    );
    expect(winners).toHaveLength(1);
    const stored = await env.STAGING.get(winners[0]!.key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(candidates[acceptedIndex]);
  });

  describe.sequential("post-R2 crash recovery", () => {
    const recoveries: { session: string; type: FrameType; target: Uint8Array }[] = [];

    it("leaves no partial frame, registry, or lifecycle commit after R2", async () => {
      const cases = [FrameType.Schema, FrameType.Samples, FrameType.ClockAnchor, FrameType.End];
      for (const type of cases) {
        if (type !== cases[0]) SESSION = String(sessionCounter++);
        useBinaryRun();
        mockAlloy();
        await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
        let seq = 1;
        if (type === FrameType.Samples) {
          await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), seq++));
        }
        const payload = type === FrameType.Schema
          ? schemaPayload()
          : type === FrameType.Samples
            ? samplesPayload()
            : type === FrameType.ClockAnchor
              ? anchorPayload()
              : endPayload({
                  attemptedSamples: 0,
                  encodedSamples: 0,
                  droppedSamples: 0,
                });
        const target = binaryFrame(type, payload, seq);
        const stub = await sessionStub();
        await failNextBinaryCommit(stub);

        const failedResponse = await postBinary(target);
        expect(failedResponse.status, `type ${type}`).toBe(503);
        expect(await readAck(failedResponse)).toMatchObject({
          status: AckStatus.InternalError,
        });
        const durable = await runInDurableObject(
          await sessionStub(),
          async (_instance: unknown, state: DurableObjectState) => {
            const result = {
              frames: state.storage.sql
                .exec<{ count: number }>(
                  "SELECT COUNT(*) AS count FROM binary_frames WHERE frame_seq = ?",
                  seq,
                )
                .toArray()[0]!.count,
              schemas: state.storage.sql
                .exec<{ count: number }>(
                  "SELECT COUNT(*) AS count FROM binary_schemas WHERE frame_seq = ?",
                  seq,
                )
                .toArray()[0]!.count,
              anchors: state.storage.sql
                .exec<{ count: number }>(
                  "SELECT COUNT(*) AS count FROM binary_anchors WHERE frame_seq = ?",
                  seq,
                )
                .toArray()[0]!.count,
              session: JSON.parse(
                state.storage.sql
                  .exec<{ state_json: string }>(
                    "SELECT state_json FROM binary_session WHERE singleton = 1",
                  )
                  .toArray()[0]!.state_json,
              ) as { phase: string; lowestMissingSeq: number; endSeq?: number },
            };
            await state.storage.deleteAlarm();
            return result;
          },
        );
        expect(durable, `type ${type}`).toMatchObject({
          frames: 0,
          schemas: 0,
          anchors: 0,
          session: { phase: "receiving", lowestMissingSeq: seq },
        });
        expect(durable.session.endSeq).toBeUndefined();
        const staged = await env.STAGING.list();
        expect(staged.objects.some(
          (object: R2Object) => object.key.includes(
            `/${SESSION}/frames/${String(seq).padStart(10, "0")}-`,
          ),
        )).toBe(true);
        recoveries.push({ session: SESSION, type, target });
      }

      // workerd cannot gracefully evict a test DO after this injected R2 failure. Clear every
      // volatile ingest field; the next request must reconstruct its authoritative view from the
      // durable SQLite rows inspected above, which is the same code path used after a restart.
      for (const recovery of recoveries) {
        SESSION = recovery.session;
        await runInDurableObject(await sessionStub(), (instance: unknown) => {
          const target = instance as Record<string, unknown>;
          Reflect.set(target, "recentChunks", []);
          Reflect.set(target, "binaryTail", Promise.resolve());
          Reflect.set(target, "nextBinaryStageDelayMs", 0);
          Reflect.set(target, "nextBinaryStageFailureAfterPut", false);
        });
      }

    });

    it("accepts every frame after restart-equivalent rehydration instead of duplicate-ACKing", async () => {
      expect(recoveries).toHaveLength(4);
      for (const recovery of recoveries) {
        SESSION = recovery.session;
        const retried = await postBinary(recovery.target);
        expect(retried.status, `type ${recovery.type}`).toBe(200);
        expect(await readAck(retried)).toMatchObject({ status: AckStatus.Accepted });
      }
    });
  });

  it("rejects unknown sample schemas before staging and pins the session format", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    const sample = binaryFrame(FrameType.Samples, samplesPayload(), 1);
    const rejected = await postBinary(sample);
    expect(rejected.status).toBe(400);
    expect(await readAck(rejected)).toMatchObject({
      status: AckStatus.UnknownSchema,
      detail: AckDetail.None,
    });

    const staged = await env.STAGING.list();
    expect(
      staged.objects.some(
        (item: R2Object) =>
          item.key.includes(`/${SESSION}/frames/0000000001-`),
      ),
    ).toBe(false);

    const mixed = await (await sessionStub()).fetch("https://do.internal/v1/chunk", {
      method: "POST",
      body: "t_ns,x\n1,2\n",
    });
    expect(mixed.status).toBe(409);
    expect(await mixed.text()).toBe("session format is binary");
  });

  it("does not let a later schema declaration authorize an earlier sample frame", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    expect((await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 2))).status).toBe(200);
    const sample = binaryFrame(FrameType.Samples, samplesPayload(), 1);
    const response = await postBinary(sample);
    expect(response.status).toBe(400);
    expect(await readAck(response)).toMatchObject({ status: AckStatus.UnknownSchema });
    const count = await runInDurableObject(
      await sessionStub(),
      (_instance: unknown, state: DurableObjectState) => state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM binary_frames WHERE frame_seq = 1",
        )
        .toArray()[0]!.count,
    );
    expect(count).toBe(0);
  });

  it("rejects unknown nonzero anchor references before staging", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    const unknownAnchor = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 42, temp: 20, healthy: true }],
      }),
      2,
    );
    const response = await postBinary(unknownAnchor);
    expect(response.status).toBe(400);
    expect(await readAck(response)).toMatchObject({ status: AckStatus.InvalidSample });
    const stub = await sessionStub();
    const stored = (await runInDurableObject(
      stub,
      (_instance: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM binary_frames WHERE frame_seq = 2",
          )
          .toArray()[0]!.count,
    )) as number;
    expect(stored).toBe(0);
  });

  it("requires samples to use exactly the greatest prior anchor declaration", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    await postBinary(binaryFrame(FrameType.ClockAnchor, anchorPayload({ id: 1 }), 2));
    await postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 1, temp: 20, healthy: true }],
      }),
      3,
    ));
    await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ id: 2, monoUs: 1200n, utcNs: 1_700_000_000_000_200_000n }),
      4,
    ));
    // A future declaration can arrive early, but cannot be referenced retroactively.
    await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ id: 3, monoUs: 1400n, utcNs: 1_700_000_000_000_400_000n }),
      6,
    ));
    for (const anchorId of [0, 1, 3]) {
      const response = await postBinary(binaryFrame(
        FrameType.Samples,
        samplesPayload({
          baseUs: 1300n,
          rows: [{ deltaUs: 0, sampleSeq: 2, anchorId, temp: 21, healthy: true }],
        }),
        5,
      ));
      expect(response.status, `anchor ${anchorId}`).toBe(400);
      expect(await readAck(response)).toMatchObject({ status: AckStatus.InvalidSample });
    }
    expect((await postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 1300n,
        rows: [{ deltaUs: 0, sampleSeq: 2, anchorId: 2, temp: 21, healthy: true }],
      }),
      5,
    ))).status).toBe(200);
  });

  it("orders anchor IDs by declaration frame sequence rather than arrival", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    expect((await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ id: 2, monoUs: 1200n }),
      2,
    ))).status).toBe(200);
    expect((await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ id: 1, monoUs: 1000n }),
      1,
    ))).status).toBe(200);

    SESSION = String(sessionCounter++);
    useBinaryRun();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ id: 1, monoUs: 1200n }),
      2,
    ));
    const reversed = await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ id: 2, monoUs: 1000n }),
      1,
    ));
    expect(reversed.status).toBe(409);
    expect(await readAck(reversed)).toMatchObject({
      status: AckStatus.ProtocolFormatConflict,
    });
  });

  it("rejects absolute and projected sample timestamp overflow before staging", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));

    const absoluteOverflow = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 0xffff_ffff_ffff_ffffn,
        rows: [
          { deltaUs: 0, sampleSeq: 1, temp: 20, healthy: true },
          { deltaUs: 1, sampleSeq: 2, temp: 21, healthy: true },
        ],
      }),
      2,
    );
    const absoluteResponse = await postBinary(absoluteOverflow);
    expect(absoluteResponse.status).toBe(400);
    expect(await readAck(absoluteResponse)).toMatchObject({ status: AckStatus.InvalidSample });

    expect((await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ monoUs: 1000n, utcNs: 0xffff_ffff_ffff_ffffn }),
      2,
    ))).status).toBe(200);
    const projectedOverflow = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 1001n,
        rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 1, temp: 20, healthy: true }],
      }),
      3,
    );
    const projectedResponse = await postBinary(projectedOverflow);
    expect(projectedResponse.status).toBe(400);
    expect(await readAck(projectedResponse)).toMatchObject({ status: AckStatus.InvalidSample });
  });

  it("rejects anchors and GAPs that would project retained times outside MCAP u64", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    await postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 900n,
        rows: [{ deltaUs: 0, sampleSeq: 1, temp: 20, healthy: true }],
      }),
      2,
    ));
    const negativeProjection = await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload({ monoUs: 1000n, utcNs: 1n }),
      3,
    ));
    expect(negativeProjection.status).toBe(400);
    expect(await readAck(negativeProjection)).toMatchObject({
      status: AckStatus.ProtocolFormatConflict,
    });

    const gap = gapPayload();
    const gapView = new DataView(gap.buffer);
    gapView.setBigUint64(20, 18_446_744_073_709_552n, true);
    gapView.setBigUint64(28, 18_446_744_073_709_552n, true);
    const gapResponse = await postBinary(binaryFrame(FrameType.Gap, gap, 3));
    expect(gapResponse.status).toBe(400);
    expect(await readAck(gapResponse)).toMatchObject({
      status: AckStatus.ProtocolFormatConflict,
    });
  });

  it("requires contiguous declaration state and enforces cross-frame sample order", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    const later = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 3000n,
        rows: [{ deltaUs: 0, sampleSeq: 30, temp: 30, healthy: true }],
      }),
      3,
    );
    const blocked = await postBinary(later);
    expect(blocked.status).toBe(503);
    expect(await readAck(blocked)).toMatchObject({
      status: AckStatus.Busy,
      lowestMissing: 2,
    });

    const overlapping = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 2000n,
        rows: [{ deltaUs: 0, sampleSeq: 20, temp: 20, healthy: true }],
      }),
      2,
    );
    expect((await postBinary(overlapping)).status).toBe(200);

    const invalidSuccessor = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 3000n,
        rows: [{ deltaUs: 0, sampleSeq: 20, temp: 30, healthy: true }],
      }),
      3,
    );
    const overlapResponse = await postBinary(invalidSuccessor);
    expect(overlapResponse.status).toBe(409);
    expect(await readAck(overlapResponse)).toMatchObject({ status: AckStatus.InvalidSample });

    expect((await postBinary(later)).status).toBe(200);

    const regressingTime = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 2500n,
        rows: [{ deltaUs: 0, sampleSeq: 40, temp: 40, healthy: true }],
      }),
      4,
    );
    const regressionResponse = await postBinary(regressingTime);
    expect(regressionResponse.status).toBe(409);
    expect(await readAck(regressionResponse)).toMatchObject({ status: AckStatus.InvalidSample });

    const stub = await sessionStub();
    const rows = (await runInDurableObject(
      stub,
      (_instance: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec<{ frame_seq: number }>(
            "SELECT frame_seq FROM binary_frames WHERE frame_type = 5 ORDER BY frame_seq",
          )
          .toArray(),
    )) as { frame_seq: number }[];
    expect(rows.map((row) => row.frame_seq)).toEqual([2, 3]);
  });

  it("never duplicate-ACKs concurrent identical frames that fail stateful validation", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    await postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 2000n,
        rows: [{ deltaUs: 0, sampleSeq: 20, temp: 20, healthy: true }],
      }),
      2,
    ));
    const invalid = binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 1500n,
        rows: [{ deltaUs: 0, sampleSeq: 10, temp: 15, healthy: true }],
      }),
      3,
    );
    const responses = await Promise.all([postBinary(invalid), postBinary(invalid)]);
    expect(responses.map((response) => response.status)).toEqual([409, 409]);
    const acks = await Promise.all(responses.map((response) => readAck(response)));
    expect(acks.map((ack) => ack.status)).toEqual([
      AckStatus.InvalidSample,
      AckStatus.InvalidSample,
    ]);
    const stub = await sessionStub();
    const count = (await runInDurableObject(
      stub,
      (_instance: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM binary_frames WHERE frame_seq = 3",
          )
          .toArray()[0]!.count,
    )) as number;
    expect(count).toBe(0);
  });

  it("validates cumulative counters against both sequence neighbors and the END payload", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    const maximums = {
      droppedSamples: 2,
      droppedFrames: 2,
      corruptFrames: 2,
      backpressureEvents: 2,
      retryAttempts: 2,
    };
    expect((await postBinary(binaryFrame(
      FrameType.Schema,
      schemaPayload(),
      2,
      maximums,
    ))).status).toBe(200);

    const aboveSuccessor = await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload(),
      1,
      {
        droppedSamples: 3,
        droppedFrames: 3,
        corruptFrames: 3,
        backpressureEvents: 3,
        retryAttempts: 3,
      },
    ));
    expect(aboveSuccessor.status).toBe(409);
    expect(await readAck(aboveSuccessor)).toMatchObject({
      status: AckStatus.ProtocolFormatConflict,
    });
    expect((await postBinary(binaryFrame(
      FrameType.ClockAnchor,
      anchorPayload(),
      1,
      {
        droppedSamples: 1,
        droppedFrames: 1,
        corruptFrames: 1,
        backpressureEvents: 1,
        retryAttempts: 1,
      },
    ))).status).toBe(200);

    const contradictedEnd = await postBinary(binaryFrame(
      FrameType.End,
      endPayload({
        attemptedSamples: 0,
        encodedSamples: 0,
        droppedSamples: 0,
      }),
      3,
      maximums,
    ));
    expect(contradictedEnd.status).toBe(409);
    expect(await readAck(contradictedEnd)).toMatchObject({
      status: AckStatus.ProtocolFormatConflict,
    });

    const validEnd = await postBinary(binaryFrame(
      FrameType.End,
      endPayload({
        attemptedSamples: 2,
        encodedSamples: 0,
        droppedSamples: 2,
        droppedFrames: 2,
        corruptFrames: 2,
        backpressureEvents: 2,
        retryAttempts: 2,
      }),
      3,
      maximums,
    ));
    expect(validEnd.status).toBe(200);
    expect(await readAck(validEnd)).toMatchObject({ status: AckStatus.Accepted });
  });

  it("rejects a divergent immutable schema revision without replacing it", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    const originalPayload = schemaPayload();
    await postBinary(binaryFrame(FrameType.Schema, originalPayload, 1));
    const changedPayload = schemaPayload({
      id: 1,
      revision: 1,
      flags: 0,
      channel: "env",
      fields: [
        { id: 0, type: 8, flags: 0, name: "temperature", unit: "degC" },
        { id: 1, type: 1, flags: 0, name: "healthy", unit: "" },
      ],
    });
    const conflict = await postBinary(binaryFrame(FrameType.Schema, changedPayload, 2));
    expect(conflict.status).toBe(409);
    expect(await readAck(conflict)).toMatchObject({ status: AckStatus.SchemaConflict });

    const stub = await sessionStub();
    const stored = (await runInDurableObject(
      stub,
      (_instance: unknown, state: DurableObjectState) =>
        state.storage.sql
          .exec<{ schema_json: string }>(
            "SELECT schema_json FROM binary_schemas WHERE schema_id = 1 AND revision = 1",
          )
          .toArray()[0],
    )) as { schema_json: string };
    expect(JSON.parse(stored.schema_json).fields[0].name).toBe("temp_c");
  });

  it("accepts frame-sequence reordering after schema validity and finalizes a typed mission", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE, mission: "uno drive" }), 0));
    // Nondependent declarations may arrive out of order; SAMPLES waits until the prefix is whole.
    expect((await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 2))).status).toBe(200);
    expect((await postBinary(binaryFrame(FrameType.ClockAnchor, anchorPayload(), 1))).status).toBe(200);
    expect((await postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        baseUs: 1100n,
        rows: [
          { deltaUs: 0, sampleSeq: 1, anchorId: 1, temp: 22.5, healthy: true },
          { deltaUs: 10, sampleSeq: 2, anchorId: 1, temp: 23.25, healthy: false },
        ],
      }),
      3,
    ))).status).toBe(200);
    const end = binaryFrame(FrameType.End, endPayload(), 4, { droppedSamples: 2 });
    expect((await postBinary(end)).status).toBe(200);

    await runDurableObjectAlarm(await sessionStub());
    await waitForState((state) => state.phase === "done");
    expect(meshPuts).toContainEqual(
      `/test-bucket/uploads/sdk-uploads/${MESH}/${SESSION}/${DEVICE}_${SESSION}.mcap`,
    );
    const after = await env.STAGING.list();
    expect(after.objects.filter((item: R2Object) => item.key.includes(`/${SESSION}/`))).toHaveLength(0);

    // Hash tombstones remain sufficient to ACK a byte-identical retry after R2 cleanup.
    const duplicate = await postBinary(end);
    expect(duplicate.status).toBe(200);
    expect(await readAck(duplicate)).toMatchObject({
      status: AckStatus.Duplicate,
      flags: AckFlag.Accepted | AckFlag.Duplicate | AckFlag.RunTerminal,
    });
    const late = await postBinary(binaryFrame(FrameType.Samples, samplesPayload(), 5));
    expect(late.status).toBe(409);
    expect(await readAck(late)).toMatchObject({
      status: AckStatus.RunFinalized,
      detail: AckDetail.None,
    });
  });

  it("uses an explicit GAP to close a missing frame interval before END finalization", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    const end = await postBinary(binaryFrame(
      FrameType.End,
      endPayload(),
      3,
      { droppedSamples: 2 },
    ));
    expect((await readAck(end)).lowestMissing).toBe(1);

    const gap = gapPayload();
    const gapView = new DataView(gap.buffer);
    gapView.setUint32(12, 1, true);
    gapView.setUint32(16, 1, true);
    const accepted = await postBinary(binaryFrame(FrameType.Gap, gap, 2));
    expect((await readAck(accepted)).lowestMissing).toBe(4);
    await runDurableObjectAlarm(await sessionStub());
    await waitForState((state) => state.phase === "done");
    expect(meshPuts.some((path) => path.endsWith(".mcap"))).toBe(true);
  });

  it("serializes a delayed frame commit with the alarm so finalization cannot omit its sample", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    const stub = await sessionStub();
    await delayNextStagingPut(stub);
    const sampleRequest = postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        rows: [{ deltaUs: 0, sampleSeq: 1, temp: 55, healthy: true }],
      }),
      2,
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const alarmRequest = runDurableObjectAlarm(stub);

    const [sampleResponse, alarmRan] = await Promise.all([sampleRequest, alarmRequest]);
    expect(sampleResponse.status).toBe(200);
    expect(await readAck(sampleResponse)).toMatchObject({ status: AckStatus.Accepted });
    expect(alarmRan).toBe(true);
    await waitForState((state) => state.phase === "done");

    const path = `/test-bucket/uploads/sdk-uploads/${MESH}/${SESSION}/${DEVICE}_${SESSION}.mcap`;
    const bytes = meshBodies.get(path);
    expect(bytes).toBeDefined();
    const reader = await McapIndexedReader.Initialize({ readable: new BufferReadable(bytes!) });
    const envChannel = [...reader.channelsById.values()].find((channel) => channel.topic === "/env");
    expect(envChannel).toBeDefined();
    const payloads: Record<string, unknown>[] = [];
    for await (const message of reader.readMessages({ topics: ["/env"] })) {
      payloads.push(JSON.parse(new TextDecoder().decode(message.data)));
    }
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ temp_c: 55, _alloy_sample_seq: 1 });
  });

  it("clears credentials after finalization retry exhaustion and safely resumes on auth", async () => {
    useBinaryRun();
    mockAlloy({ failPuts: 10 });
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    await postBinary(binaryFrame(
      FrameType.Samples,
      samplesPayload({
        rows: [{ deltaUs: 0, sampleSeq: 1, temp: 20, healthy: true }],
      }),
      2,
    ));
    const endFrame = binaryFrame(
      FrameType.End,
      endPayload({
        attemptedSamples: 1,
        encodedSamples: 1,
        droppedSamples: 0,
      }),
      3,
    );
    expect((await postBinary(endFrame)).status).toBe(200);
    const stub = await sessionStub();
    for (let attempt = 1; attempt <= 10; attempt++) {
      await runDurableObjectAlarm(stub);
      await waitForState(
        (state) => state.phase === "failed" || state.finalizeAttempts >= attempt,
        5000,
      );
      if ((await storedState(stub))?.phase === "failed") break;
    }
    const failed = await waitForState((state) => state.phase === "failed", 5000);
    expect(failed).toMatchObject({
      finalizeAttempts: 10,
      apiKey: "",
      failure: "finalize_exhausted",
    });
    expect(await runInDurableObject(
      stub,
      (_instance: unknown, state: DurableObjectState) => state.storage.getAlarm(),
    )).toBeNull();

    mockAlloy({ failPuts: 0 });
    const resume = await postBinary(endFrame);
    expect(resume.status).toBe(503);
    expect(await readAck(resume)).toMatchObject({
      status: AckStatus.Busy,
      flags: AckFlag.Retryable,
    });
    await runDurableObjectAlarm(stub);
    await waitForState((state) => state.phase === "done", 5000);
    expect(meshPuts.some((path) => path.endsWith(".mcap"))).toBe(true);
  });

  it("inactivity-finalizes a binary run with no RUN_END", async () => {
    useBinaryRun();
    mockAlloy();
    await postBinary(binaryFrame(FrameType.Begin, beginPayload({ device: DEVICE }), 0));
    await postBinary(binaryFrame(FrameType.Schema, schemaPayload(), 1));
    await postBinary(
      binaryFrame(
        FrameType.Samples,
        samplesPayload({
          rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 0, temp: 20, healthy: true }],
        }),
        2,
      ),
    );
    expect(await runDurableObjectAlarm(await sessionStub())).toBe(true);
    await waitForState((state) => state.phase === "done");
    expect(meshPuts.some((path) => path.endsWith(".mcap"))).toBe(true);
  });
});
