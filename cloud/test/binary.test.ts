import { McapIndexedReader } from "@mcap/core";
import type { IReadable } from "@mcap/core";
import { describe, expect, it } from "vitest";
import {
  AckFlag,
  AckStatus,
  BodyTooLargeError,
  FrameType,
  crc32c,
  encodeAck,
  parseBegin,
  parseClockAnchor,
  parseEnd,
  parseFrame,
  parseGap,
  parseSamples,
  parseSchema,
  projectTimestampU64,
  readBoundedBody,
  validateStatelessPayload,
} from "../src/binary";
import { assembleBinaryMcap } from "../src/binary-mcap";
import {
  TEST_RUN_HEX,
  TEST_RUN_ID,
  TEST_SCHEMA,
  anchorPayload,
  beginPayload,
  endPayload,
  gapPayload,
  makeFrame,
  samplesPayload,
  schemaPayload,
} from "./wire-fixture";

class BufferReadable implements IReadable {
  constructor(private readonly bytes: Uint8Array) {}
  async size(): Promise<bigint> {
    return BigInt(this.bytes.byteLength);
  }
  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    return this.bytes.subarray(Number(offset), Number(offset + size));
  }
}

function replayable(entries: { seq: number; bytes: Uint8Array }[]) {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const gaps = sorted
    .filter((entry) => parseFrame(entry.bytes).header.type === FrameType.Gap)
    .sort((left, right) => {
      const leftGap = parseGap(parseFrame(left.bytes).payload);
      const rightGap = parseGap(parseFrame(right.bytes).payload);
      if (leftGap.monotonicStartUs !== rightGap.monotonicStartUs) {
        return leftGap.monotonicStartUs < rightGap.monotonicStartUs ? -1 : 1;
      }
      return left.seq - right.seq;
    });
  return {
    frames: async function* () {
      for (const entry of sorted) yield entry;
    },
    gapFrames: async function* () {
      for (const entry of gaps) yield entry;
    },
  };
}

describe("Alloy Device Wire v1 envelope", () => {
  it("matches the standard CRC32C check vector", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  });

  it("reproduces and decodes the contract's canonical RUN_BEGIN and ACK vectors", () => {
    const fromHex = (hex: string) =>
      Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
    const toHex = (bytes: Uint8Array) =>
      [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const frameHex =
      "414c59310101000040001c0000000000000102030405060708090a0b0c0d0e0f01000600000000000000000000000000000000000000000000000000747ccf680903000101000000e803000000000000756e6f2d72342d3031667731";
    const ackHex =
      "414c59410100010030000000000000000100000000000000000102030405060708090a0b0c0d0e0f21eb0099747ccf68";
    const frame = parseFrame(fromHex(frameHex));
    expect(parseBegin(frame.payload)).toMatchObject({
      device: "uno-r4-01",
      firmware: "fw1",
      mission: "",
      monotonicStartUs: 1000n,
    });
    const ack = encodeAck({
      status: AckStatus.Accepted,
      flags: AckFlag.Accepted,
      ackSeq: 0,
      lowestMissingSeq: 1,
      runId: frame.header.runId,
      requestCrc32c: frame.header.crc32c,
    });
    expect(toHex(ack)).toBe(ackHex);
  });

  it("parses a bounded BEGIN frame and its exact run identity", () => {
    const frame = parseFrame(makeFrame(FrameType.Begin, beginPayload()));
    validateStatelessPayload(frame);
    expect(frame.header.runIdHex).toBe(TEST_RUN_HEX);
    expect(parseBegin(frame.payload)).toMatchObject({
      device: "uno-r4",
      firmware: "test-fw",
      mission: "bench run",
      reliabilityTier: 1,
    });
  });

  it("reserves the maximum frame sequence sentinel", () => {
    expect(() => parseFrame(makeFrame(
      FrameType.Begin,
      beginPayload(),
      { seq: 0xffff_ffff },
    ))).toThrow(/maximum frame sequence/);
  });

  it.each([
    ["magic", (b: Uint8Array) => { b[0] ^= 1; }],
    ["version", (b: Uint8Array) => { b[4] = 2; }],
    ["header length", (b: Uint8Array) => { new DataView(b.buffer).setUint16(8, 63, true); }],
    ["declared payload", (b: Uint8Array) => { new DataView(b.buffer).setUint16(10, 0, true); }],
    ["reserved", (b: Uint8Array) => { b[56] = 1; }],
    ["crc", (b: Uint8Array) => { b[b.length - 1] ^= 1; }],
    ["journal bounds", (b: Uint8Array) => {
      const view = new DataView(b.buffer);
      view.setUint16(32, 5, true);
      view.setUint16(34, 4, true);
      view.setUint32(60, crc32c(b, 60, 4), true);
    }],
  ])("rejects an invalid %s", (_name, mutate) => {
    const bytes = makeFrame(FrameType.Begin, beginPayload());
    mutate(bytes);
    expect(() => parseFrame(bytes)).toThrow();
  });

  it("reads the actual stream bound even with missing or spoofed Content-Length", async () => {
    const exactly = new Uint8Array(1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(exactly);
        controller.close();
      },
    });
    const withoutLength = new Request("https://test", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(withoutLength.headers.get("Content-Length")).toBeNull();
    expect((await readBoundedBody(withoutLength)).length).toBe(1024);
    const tooLarge = new Uint8Array(1025);
    const spoofed = new Request("https://test", {
      method: "POST",
      headers: { "Content-Length": "1" },
      body: tooLarge,
    });
    await expect(readBoundedBody(spoofed)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("encodes a protected 48-byte ACK with reclaim fields", () => {
    const ack = encodeAck({
      status: AckStatus.Duplicate,
      flags: AckFlag.Accepted | AckFlag.Duplicate,
      ackSeq: 42,
      lowestMissingSeq: 7,
      runId: TEST_RUN_ID,
      requestCrc32c: 0x12345678,
    });
    const view = new DataView(ack.buffer);
    expect(new TextDecoder().decode(ack.subarray(0, 4))).toBe("ALYA");
    expect(ack).toHaveLength(48);
    expect(view.getUint32(12, true)).toBe(42);
    expect(view.getUint32(16, true)).toBe(7);
    expect(view.getUint32(44, true)).toBe(0x12345678);
    expect(view.getUint32(40, true)).toBe(crc32c(ack, 40, 4));
  });
});

describe("payload conformance", () => {
  it("pins contiguous field ids and decodes fixed-width typed samples", () => {
    const schema = parseSchema(schemaPayload());
    const samples = parseSamples(samplesPayload(), (id, revision) =>
      id === schema.id && revision === schema.revision ? schema : undefined,
    );
    expect(samples.samples.map((sample) => sample.values)).toEqual([
      { temp_c: 22.5, healthy: true },
      { temp_c: 23.25, healthy: false },
    ]);

    const invalid = { ...TEST_SCHEMA, fields: TEST_SCHEMA.fields.map((field) => ({ ...field })) };
    invalid.fields[1]!.id = 3;
    expect(() => parseSchema(schemaPayload(invalid))).toThrow(/contiguous/);
  });

  it("rejects sample schema mismatches, non-finite floats, and regressing deltas", () => {
    const schema = parseSchema(schemaPayload());
    expect(() => parseSamples(samplesPayload(), () => undefined)).toThrow(/unknown schema/);

    const nan = samplesPayload();
    new DataView(nan.buffer).setFloat32(36, Number.NaN, true);
    expect(() => parseSamples(nan, () => schema)).toThrow(/non-finite/);

    const badMask = samplesPayload();
    new DataView(badMask.buffer).setUint16(16 + 16, 0x8003, true);
    expect(() => parseSamples(badMask, () => schema)).toThrow(/present mask/);

    const badBool = samplesPayload();
    new DataView(badBool.buffer).setUint8(16 + 24, 2);
    expect(() => parseSamples(badBool, () => schema)).toThrow(/boolean/);

    const nonzeroAbsent = samplesPayload();
    new DataView(nonzeroAbsent.buffer).setUint16(16 + 16, 0x0002, true);
    expect(() => parseSamples(nonzeroAbsent, () => schema)).toThrow(/absent/);
    nonzeroAbsent.subarray(16 + 20, 16 + 24).fill(0);
    expect(parseSamples(nonzeroAbsent, () => schema).samples[0]!.values).toEqual({ healthy: true });

    const backwards = samplesPayload({
      rows: [
        { deltaUs: 0, sampleSeq: 1, temp: 1, healthy: true },
        { deltaUs: 0, sampleSeq: 2, temp: 2, healthy: true },
      ],
    });
    new DataView(backwards.buffer).setUint32(16 + 25 + 12, 1, true);
    new DataView(backwards.buffer).setUint32(16 + 12, 2, true);
    expect(() => parseSamples(backwards, () => schema)).toThrow(/nondecreasing/);

    const exhausted = samplesPayload({
      rows: [
        { deltaUs: 0, sampleSeq: 0xffff_ffff, temp: 1, healthy: true },
      ],
    });
    expect(() => parseSamples(exhausted, () => schema)).toThrow(/maximum sample sequence/);
  });

  it("rejects absolute and projected timestamp overflow", () => {
    const schema = parseSchema(schemaPayload());
    const absoluteOverflow = samplesPayload({
      baseUs: 0xffff_ffff_ffff_ffffn,
      rows: [
        { deltaUs: 0, sampleSeq: 1, temp: 1, healthy: true },
        { deltaUs: 1, sampleSeq: 2, temp: 2, healthy: true },
      ],
    });
    expect(() => parseSamples(absoluteOverflow, () => schema)).toThrow(/overflows u64/);
    expect(() => projectTimestampU64(0xffff_ffff_ffff_ffffn)).toThrow(/u64 range/);
    expect(() => projectTimestampU64(1n, -1001n)).toThrow(/u64 range/);
  });

  it("validates exact GAP and END shapes", () => {
    expect(parseGap(gapPayload())).toMatchObject({ lostSampleCount: 2, lostFrameCount: 0 });
    expect(parseEnd(endPayload())).toMatchObject({ attemptedSamples: 4, encodedSamples: 2 });
    expect(() => parseGap(gapPayload().subarray(1))).toThrow(/40 bytes/);
    expect(() => parseEnd(endPayload().subarray(1))).toThrow(/40 bytes/);
  });

  it("rejects a zero-UTC value masquerading as a real anchor", () => {
    expect(() => parseClockAnchor(anchorPayload({ utcNs: 0n }))).toThrow(/UTC/);
  });
});

describe("binary MCAP projection", () => {
  it("preserves protocol-valid prototype-like field names in schema and samples", async () => {
    const protoSchema = {
      id: 9,
      revision: 1,
      flags: 0,
      channel: "prototype_fields",
      fields: [{ id: 0, type: 8, flags: 0, name: "__proto__", unit: "" }],
    };
    const samplePayload = new Uint8Array(40);
    const sampleView = new DataView(samplePayload.buffer);
    sampleView.setUint16(0, 1, true);
    sampleView.setBigUint64(4, 900n, true);
    sampleView.setUint16(12, 20, true);
    sampleView.setUint16(16, 24, true);
    sampleView.setUint16(18, protoSchema.id, true);
    sampleView.setUint16(20, protoSchema.revision, true);
    sampleView.setUint32(24, 1, true);
    sampleView.setUint16(32, 1, true);
    sampleView.setFloat32(36, 42.5, true);

    const frames = [
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      { seq: 1, bytes: makeFrame(FrameType.Schema, schemaPayload(protoSchema), { seq: 1 }) },
      { seq: 2, bytes: makeFrame(FrameType.Samples, samplePayload, { seq: 2 }) },
      {
        seq: 3,
        bytes: makeFrame(
          FrameType.End,
          endPayload({ attemptedSamples: 1, encodedSamples: 1, droppedSamples: 0 }),
          { seq: 3 },
        ),
      },
    ];
    const bytes = (await assembleBinaryMcap(replayable(frames), {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    }))!;
    const reader = await McapIndexedReader.Initialize({ readable: new BufferReadable(bytes) });
    const channel = [...reader.channelsById.values()].find(
      (candidate) => candidate.topic === "/prototype_fields",
    )!;
    const schema = JSON.parse(
      new TextDecoder().decode(reader.schemasById.get(channel.schemaId)!.data),
    );
    expect(Object.hasOwn(schema.properties, "__proto__")).toBe(true);
    expect(schema.properties.__proto__.type).toBe("number");

    const messages = [];
    for await (const message of reader.readMessages({ topics: ["/prototype_fields"] })) {
      messages.push(JSON.parse(new TextDecoder().decode(message.data)));
    }
    expect(messages).toHaveLength(1);
    expect(Object.hasOwn(messages[0], "__proto__")).toBe(true);
    expect(messages[0].__proto__).toBe(42.5);
  });

  it("sorts samples, emits typed revision channels, anchors/gaps, and mission metadata", async () => {
    const frames = [
      { seq: 5, bytes: makeFrame(FrameType.End, endPayload(), { seq: 5, droppedSamples: 2 }) },
      { seq: 2, bytes: makeFrame(FrameType.Samples, samplesPayload(), { seq: 2 }) },
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      { seq: 4, bytes: makeFrame(FrameType.Gap, gapPayload(), { seq: 4, droppedSamples: 2 }) },
      { seq: 3, bytes: makeFrame(FrameType.ClockAnchor, anchorPayload(), { seq: 3 }) },
      { seq: 1, bytes: makeFrame(FrameType.Schema, schemaPayload(), { seq: 1 }) },
    ];
    const bytes = (await assembleBinaryMcap(replayable(frames), {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    }))!;
    const reader = await McapIndexedReader.Initialize({ readable: new BufferReadable(bytes) });
    const topics = [...reader.channelsById.values()].map((channel) => channel.topic);
    expect(topics).toContain("/env");
    expect(topics).toContain("/alloy/clock_anchor");
    expect(topics).toContain("/alloy/gap");

    const envChannel = [...reader.channelsById.values()].find((channel) => channel.topic === "/env")!;
    const schema = JSON.parse(
      new TextDecoder().decode(reader.schemasById.get(envChannel.schemaId)!.data),
    );
    expect(schema.properties.temp_c.type).toBe("number");
    expect(schema.properties.healthy.type).toBe("boolean");
    expect(schema.properties._alloy_mono_us.type).toBe("string");

    const envMessages: { time: bigint; body: Record<string, unknown> }[] = [];
    const orderedTopics: string[] = [];
    const orderedTimes: bigint[] = [];
    for await (const message of reader.readMessages()) {
      orderedTopics.push(reader.channelsById.get(message.channelId)!.topic);
      orderedTimes.push(message.logTime);
      if (message.channelId === envChannel.id) {
        envMessages.push({
          time: message.logTime,
          body: JSON.parse(new TextDecoder().decode(message.data)),
        });
      }
    }
    expect(envMessages.map((message) => message.body.temp_c)).toEqual([22.5, 23.25]);
    expect(envMessages[0]!.body).toMatchObject({
      _alloy_mono_us: "900",
      _alloy_anchor_id: 0,
      _alloy_sample_seq: 1,
      _alloy_utc_anchored: true,
    });
    expect(envMessages[1]!.time > envMessages[0]!.time).toBe(true);
    expect(orderedTopics).toEqual([
      "/env",
      "/env",
      "/alloy/gap",
      "/alloy/clock_anchor",
    ]);
    expect(orderedTimes).toEqual([...orderedTimes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const metadata = [];
    for await (const item of reader.readMetadata({ name: "alloy" })) metadata.push(item.metadata);
    expect(metadata[0]!.get("mission")).toBe("bench run");
    expect(metadata[0]!.get("clock_quality")).toBe("synchronized");
    expect(metadata[0]!.get("complete")).toBe("false");
  });

  it("emits late-declared historical GAPs in chronological MCAP order", async () => {
    const newerGap = gapPayload();
    const newerView = new DataView(newerGap.buffer);
    newerView.setBigUint64(20, 1900n, true);
    newerView.setBigUint64(28, 1950n, true);
    newerView.setUint32(36, 19, true);
    const historicalGap = gapPayload();
    const historicalView = new DataView(historicalGap.buffer);
    historicalView.setBigUint64(20, 1000n, true);
    historicalView.setBigUint64(28, 1050n, true);
    historicalView.setUint32(36, 10, true);
    const frames = [
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      { seq: 1, bytes: makeFrame(FrameType.Gap, newerGap, { seq: 1 }) },
      { seq: 2, bytes: makeFrame(FrameType.Gap, historicalGap, { seq: 2 }) },
    ];
    const bytes = (await assembleBinaryMcap(replayable(frames), {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    }))!;
    const reader = await McapIndexedReader.Initialize({ readable: new BufferReadable(bytes) });
    const messages: { logTime: bigint; body: Record<string, unknown> }[] = [];
    for await (const message of reader.readMessages({ topics: ["/alloy/gap"] })) {
      messages.push({
        logTime: message.logTime,
        body: JSON.parse(new TextDecoder().decode(message.data)),
      });
    }
    expect(messages.map((message) => message.body.monotonic_start_us)).toEqual([
      "1000",
      "1900",
    ]);
    expect(messages.map((message) => message.body.detail)).toEqual([10, 19]);
    expect(messages.map((message) => message.logTime)).toEqual([1_000_000n, 1_900_000n]);
  });

  it("uses monotonic nanoseconds and marks metadata when no UTC anchor exists", async () => {
    const frames = [
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      { seq: 1, bytes: makeFrame(FrameType.Schema, schemaPayload(), { seq: 1 }) },
      {
        seq: 2,
        bytes: makeFrame(
          FrameType.Samples,
          samplesPayload({
            baseUs: 1234n,
            rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 0, temp: 10, healthy: true }],
          }),
          { seq: 2 },
        ),
      },
    ];
    const bytes = (await assembleBinaryMcap(replayable(frames), {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    }))!;
    const reader = await McapIndexedReader.Initialize({ readable: new BufferReadable(bytes) });
    const messages = [];
    for await (const message of reader.readMessages()) messages.push(message);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.logTime).toBe(1_234_000n);
    const metadata = [];
    for await (const item of reader.readMetadata({ name: "alloy" })) metadata.push(item.metadata);
    expect(metadata[0]!.get("utc_anchored")).toBe("false");
    expect(metadata[0]!.get("clock_quality")).toBe("none");
  });

  it("keeps observed cumulative maxima when an END payload reports lower counters", async () => {
    const frames = [
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      {
        seq: 1,
        bytes: makeFrame(FrameType.Schema, schemaPayload(), { seq: 1, droppedSamples: 5 }),
      },
      {
        seq: 2,
        bytes: makeFrame(
          FrameType.End,
          endPayload({
            attemptedSamples: 5,
            encodedSamples: 0,
            droppedSamples: 0,
          }),
          { seq: 2, droppedSamples: 5 },
        ),
      },
    ];
    const bytes = (await assembleBinaryMcap(replayable(frames), {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    }))!;
    const reader = await McapIndexedReader.Initialize({ readable: new BufferReadable(bytes) });
    const metadata = [];
    for await (const item of reader.readMetadata({ name: "alloy" })) metadata.push(item.metadata);
    expect(metadata[0]!.get("reported_dropped_samples")).toBe("5");
    expect(metadata[0]!.get("complete")).toBe("false");
  });

  it("fails closed if a staged monotonic timestamp cannot fit MCAP u64 nanoseconds", async () => {
    const frames = [
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      { seq: 1, bytes: makeFrame(FrameType.Schema, schemaPayload(), { seq: 1 }) },
      {
        seq: 2,
        bytes: makeFrame(
          FrameType.Samples,
          samplesPayload({
            baseUs: 18_446_744_073_709_552n,
            rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 0, temp: 10, healthy: true }],
          }),
          { seq: 2 },
        ),
      },
    ];
    await expect(assembleBinaryMcap(replayable(frames), {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    })).rejects.toThrow(/u64 range/);
  });

  it("replays passes while retaining at most one raw input frame at a time", async () => {
    const entries = [
      { seq: 0, bytes: makeFrame(FrameType.Begin, beginPayload(), { seq: 0 }) },
      { seq: 1, bytes: makeFrame(FrameType.Schema, schemaPayload(), { seq: 1 }) },
      {
        seq: 2,
        bytes: makeFrame(
          FrameType.Samples,
          samplesPayload({
            rows: [{ deltaUs: 0, sampleSeq: 1, anchorId: 0, temp: 12, healthy: true }],
          }),
          { seq: 2 },
        ),
      },
    ];
    let activeRawFrames = 0;
    let maximumActiveRawFrames = 0;
    let passCount = 0;
    const source = {
      frames: async function* () {
        passCount++;
        for (const entry of entries) {
          activeRawFrames++;
          maximumActiveRawFrames = Math.max(maximumActiveRawFrames, activeRawFrames);
          try {
            yield entry;
          } finally {
            activeRawFrames--;
          }
        }
      },
      gapFrames: async function* () {
        // This fixture has no GAP frames; the method is part of the bounded
        // replay contract even when finalization never opens it.
      },
    };
    await assembleBinaryMcap(source, {
      device: "uno-r4",
      session: TEST_RUN_HEX,
      meshPath: "robots/test",
      sequenceComplete: true,
    });
    expect(passCount).toBeGreaterThanOrEqual(2);
    expect(maximumActiveRawFrames).toBe(1);
    expect(activeRawFrames).toBe(0);
  });
});
