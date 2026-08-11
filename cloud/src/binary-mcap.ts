// Alloy Device Wire v1 frames -> one indexed, typed JSON-schema MCAP.
//
// The replayable source is scanned in several sequence-ordered passes. Each iterator retains at
// most one capped input frame; chronological emission merges at most one decoded event from each
// of three categories. Raw frame/session timelines are never accumulated. The legacy
// MemoryWritable still retains the completed MCAP unless a caller supplies a writable, so
// whole-output boundedness is explicitly outside this change.

import { McapWriter } from "@mcap/core";
import type { IWritable } from "@mcap/core";
import {
  FieldType,
  FrameType,
  type BinaryField,
  type BinarySample,
  type BinarySchema,
  type CapabilitiesPayload,
  type ClockAnchor,
  type EndPayload,
  type GapPayload,
  type WireFrame,
  parseBegin,
  parseCapabilities,
  parseClockAnchor,
  parseEnd,
  parseFrame,
  parseGap,
  parseSamples,
  parseSchema,
  projectTimestampU64,
  validateStatelessPayload,
} from "./binary";
import { LIBRARY, MemoryWritable, type SessionInfo } from "./mcap";

export interface BinaryFrameEntry {
  seq: number;
  bytes: Uint8Array;
}

export interface ReplayableBinaryFrameSource {
  /** A fresh frame-sequence-ordered iterator on every call. */
  frames(): AsyncGenerator<BinaryFrameEntry>;
  /** A fresh GAP-only iterator ordered by monotonic start, then frame sequence. */
  gapFrames(): AsyncGenerator<BinaryFrameEntry>;
}

export interface BinarySessionInfo extends SessionInfo {
  /** True when every sequence through the highest staged frame is received or explicitly lost. */
  sequenceComplete?: boolean;
}

interface SchemaEntry {
  seq: number;
  schema: BinarySchema;
}

interface Projection {
  offsetNs: bigint | null;
  quality: "synchronized" | "approximate" | "none";
  anchorId: number | null;
}

interface ScanResult {
  begin: ReturnType<typeof parseBegin>;
  caps: CapabilitiesPayload | null;
  end: EndPayload | null;
  schemas: Map<string, BinarySchema>;
  schemaEntries: SchemaEntry[];
  projection: Projection;
  frameCount: number;
  sampleCount: number;
  gapCount: number;
  gapSampleCount: string;
  gapFrameCount: string;
  maxDroppedSamples: number;
  maxDroppedFrames: number;
  maxCorruptFrames: number;
  maxBackpressureEvents: number;
  maxRetryAttempts: number;
  maximumBacklogSlots: number;
  journalCapacitySlots: number;
}

const enc = new TextEncoder();
const MAX_SCHEMA_REVISIONS_PER_RUN = 255;

function schemaKey(id: number, revision: number): string {
  return `${id}/${revision}`;
}

function jsonType(field: BinaryField): "boolean" | "integer" | "number" {
  switch (field.type) {
    case FieldType.Bool:
      return "boolean";
    case FieldType.F32:
    case FieldType.F64:
      return "number";
    default:
      return "integer";
  }
}

function numericBounds(type: FieldType): { minimum?: number; maximum?: number } {
  switch (type) {
    case FieldType.I8:
      return { minimum: -128, maximum: 127 };
    case FieldType.U8:
      return { minimum: 0, maximum: 255 };
    case FieldType.I16:
      return { minimum: -32768, maximum: 32767 };
    case FieldType.U16:
      return { minimum: 0, maximum: 65535 };
    case FieldType.I32:
      return { minimum: -2147483648, maximum: 2147483647 };
    case FieldType.U32:
      return { minimum: 0, maximum: 4294967295 };
    default:
      return {};
  }
}

export function buildBinarySchema(schema: BinarySchema): Record<string, unknown> {
  // A null prototype keeps valid names such as `__proto__` from invoking
  // Object.prototype setters and disappearing from the emitted JSON Schema.
  const properties: Record<string, unknown> = Object.create(null);
  for (const field of schema.fields) {
    const property: Record<string, unknown> = { type: jsonType(field), ...numericBounds(field.type) };
    if (field.unit) property.description = field.unit;
    properties[field.name] = property;
  }
  // Decimal text is deliberate for u64 monotonic time: JSON numbers cannot preserve all u64s.
  properties._alloy_mono_us = { type: "string", pattern: "^[0-9]+$" };
  properties._alloy_anchor_id = { type: "integer", minimum: 0, maximum: 65535 };
  properties._alloy_sample_seq = { type: "integer", minimum: 0, maximum: 4294967295 };
  properties._alloy_utc_anchored = { type: "boolean" };
  return { type: "object", properties };
}

const anchorSchema = {
  type: "object",
  properties: {
    anchor_id: { type: "integer" },
    source: { type: "integer" },
    quality: { type: "integer" },
    uncertainty_us: { type: "integer" },
    monotonic_us: { type: "string", pattern: "^[0-9]+$" },
    utc_ns: { type: "string", pattern: "^[0-9]+$" },
    frequency_error_ppb: { type: "integer" },
    residual_ns: { type: "string", pattern: "^-?[0-9]+$" },
  },
};

const gapSchema = {
  type: "object",
  properties: {
    reason: { type: "integer" },
    action: { type: "integer" },
    first_lost_sample_seq: { type: "integer" },
    lost_sample_count: { type: "integer" },
    first_lost_frame_seq: { type: "integer" },
    lost_frame_count: { type: "integer" },
    monotonic_start_us: { type: "string", pattern: "^[0-9]+$" },
    monotonic_end_us: { type: "string", pattern: "^[0-9]+$" },
    detail: { type: "integer" },
  },
};

function sameSchema(a: BinarySchema, b: BinarySchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SelectedAnchor {
  frameSeq: number;
  anchor: ClockAnchor;
}

function chooseEarlier(
  current: SelectedAnchor | null,
  candidate: ClockAnchor,
  frameSeq: number,
): SelectedAnchor {
  if (
    !current ||
    candidate.monotonicUs < current.anchor.monotonicUs ||
    (candidate.monotonicUs === current.anchor.monotonicUs && frameSeq < current.frameSeq)
  ) {
    return { frameSeq, anchor: candidate };
  }
  return current;
}

function sumGap(current: bigint | null, value: number): bigint | null {
  if (current === null || value === 0xffffffff) return null;
  return current + BigInt(value);
}

function assertFrameOrder(
  frame: WireFrame,
  entry: BinaryFrameEntry,
  previousSeq: number,
  runId: string | null,
): void {
  if (frame.header.frameSeq !== entry.seq) throw new Error("staged frame sequence mismatch");
  if (entry.seq <= previousSeq) throw new Error("frame source is not strictly sequence ordered");
  if (runId !== null && frame.header.runIdHex !== runId) {
    throw new Error("binary session contains mixed run ids");
  }
}

async function scanSource(
  source: ReplayableBinaryFrameSource,
  info: BinarySessionInfo,
): Promise<ScanResult> {
  let begin: ReturnType<typeof parseBegin> | null = null;
  let caps: CapabilitiesPayload | null = null;
  let end: EndPayload | null = null;
  const schemas = new Map<string, BinarySchema>();
  const schemaEntries: SchemaEntry[] = [];
  let earliestApproximate: SelectedAnchor | null = null;
  let earliestSynchronized: SelectedAnchor | null = null;
  let previousSeq = -1;
  let runId: string | null = null;
  let frameCount = 0;
  let sampleCount = 0;
  let gapCount = 0;
  let gapSamples: bigint | null = 0n;
  let gapFrames: bigint | null = 0n;
  let maxDroppedSamples = 0;
  let maxDroppedFrames = 0;
  let maxCorruptFrames = 0;
  let maxBackpressureEvents = 0;
  let maxRetryAttempts = 0;
  let maximumBacklogSlots = 0;
  let journalCapacitySlots = 0;

  for await (const entry of source.frames()) {
    const frame = parseFrame(entry.bytes);
    validateStatelessPayload(frame);
    assertFrameOrder(frame, entry, previousSeq, runId);
    previousSeq = entry.seq;
    runId ??= frame.header.runIdHex;
    if (frameCount === 0 && (entry.seq !== 0 || frame.header.type !== FrameType.Begin)) {
      throw new Error("binary session has no sequence-zero RUN_BEGIN");
    }
    frameCount++;
    maxDroppedSamples = Math.max(maxDroppedSamples, frame.header.droppedSamples);
    maxDroppedFrames = Math.max(maxDroppedFrames, frame.header.droppedFrames);
    maxCorruptFrames = Math.max(maxCorruptFrames, frame.header.corruptFrames);
    maxBackpressureEvents = Math.max(maxBackpressureEvents, frame.header.backpressureEvents);
    maxRetryAttempts = Math.max(maxRetryAttempts, frame.header.retryCount);
    maximumBacklogSlots = Math.max(maximumBacklogSlots, frame.header.journalUsed);
    journalCapacitySlots = Math.max(journalCapacitySlots, frame.header.journalCapacity);

    switch (frame.header.type) {
      case FrameType.Begin:
        if (begin) throw new Error("binary session contains multiple RUN_BEGIN frames");
        begin = parseBegin(frame.payload);
        break;
      case FrameType.Capabilities:
        caps = parseCapabilities(frame.payload);
        break;
      case FrameType.Schema: {
        const schema = parseSchema(frame.payload);
        const key = schemaKey(schema.id, schema.revision);
        const prior = schemas.get(key);
        if (prior && !sameSchema(prior, schema)) throw new Error(`conflicting schema ${key}`);
        if (!prior) {
          if (schemas.size >= MAX_SCHEMA_REVISIONS_PER_RUN) {
            throw new Error("binary session exceeds bounded schema registry");
          }
          schemas.set(key, schema);
          schemaEntries.push({ seq: entry.seq, schema });
        }
        break;
      }
      case FrameType.ClockAnchor: {
        const anchor = parseClockAnchor(frame.payload);
        if (anchor.quality === 2) {
          earliestSynchronized = chooseEarlier(earliestSynchronized, anchor, entry.seq);
        } else {
          earliestApproximate = chooseEarlier(earliestApproximate, anchor, entry.seq);
        }
        break;
      }
      case FrameType.Samples:
        sampleCount += new DataView(
          frame.payload.buffer,
          frame.payload.byteOffset,
          frame.payload.byteLength,
        ).getUint16(0, true);
        break;
      case FrameType.Gap: {
        const gap = parseGap(frame.payload);
        gapCount++;
        gapSamples = sumGap(gapSamples, gap.lostSampleCount);
        gapFrames = sumGap(gapFrames, gap.lostFrameCount);
        break;
      }
      case FrameType.End:
        if (end) throw new Error("binary session contains multiple RUN_END frames");
        end = parseEnd(frame.payload);
        break;
    }
  }

  if (!begin || !runId || frameCount === 0) throw new Error("binary session is empty");
  if (begin.device !== info.device || runId !== info.session) {
    throw new Error("binary session identity does not match pinned session info");
  }
  const projectionAnchor = earliestSynchronized ?? earliestApproximate;
  return {
    begin,
    caps,
    end,
    schemas,
    schemaEntries,
    projection: projectionAnchor
      ? {
          offsetNs:
            projectionAnchor.anchor.utcNs - projectionAnchor.anchor.monotonicUs * 1000n,
          quality: earliestSynchronized ? "synchronized" : "approximate",
          anchorId: projectionAnchor.anchor.id,
        }
      : { offsetNs: null, quality: "none", anchorId: null },
    frameCount,
    sampleCount,
    gapCount,
    gapSampleCount: gapSamples === null ? "unknown" : gapSamples.toString(),
    gapFrameCount: gapFrames === null ? "unknown" : gapFrames.toString(),
    maxDroppedSamples,
    maxDroppedFrames,
    maxCorruptFrames,
    maxBackpressureEvents,
    maxRetryAttempts,
    maximumBacklogSlots,
    journalCapacitySlots,
  };
}

type TimedBinaryEvent =
  | { kind: "anchor"; monotonicUs: bigint; frameSeq: number; anchor: ClockAnchor }
  | { kind: "sample"; monotonicUs: bigint; frameSeq: number; sample: BinarySample }
  | { kind: "gap"; monotonicUs: bigint; frameSeq: number; gap: GapPayload };

const EVENT_TIE: Record<TimedBinaryEvent["kind"], number> = {
  anchor: 0,
  sample: 1,
  gap: 2,
};

function compareEvents(left: TimedBinaryEvent, right: TimedBinaryEvent): number {
  if (left.monotonicUs !== right.monotonicUs) {
    return left.monotonicUs < right.monotonicUs ? -1 : 1;
  }
  const tie = EVENT_TIE[left.kind] - EVENT_TIE[right.kind];
  return tie !== 0 ? tie : left.frameSeq - right.frameSeq;
}

async function* sampleEvents(
  source: ReplayableBinaryFrameSource,
  schemas: Map<string, BinarySchema>,
): AsyncGenerator<TimedBinaryEvent> {
  let previousFrameSeq = -1;
  let previousMonoUs: bigint | null = null;
  let previousSampleSeq: number | null = null;
  let runId: string | null = null;
  for await (const entry of source.frames()) {
    const frame = parseFrame(entry.bytes);
    assertFrameOrder(frame, entry, previousFrameSeq, runId);
    previousFrameSeq = entry.seq;
    runId ??= frame.header.runIdHex;
    if (frame.header.type !== FrameType.Samples) continue;
    const batch = parseSamples(frame.payload, (id, revision) =>
      schemas.get(schemaKey(id, revision)),
    );
    for (const sample of batch.samples) {
      if (
        previousMonoUs !== null &&
        (sample.monotonicUs < previousMonoUs ||
          (sample.monotonicUs === previousMonoUs && sample.sampleSeq <= previousSampleSeq!))
      ) {
        throw new Error("sample tuples regress across frame sequence order");
      }
      if (previousSampleSeq !== null && sample.sampleSeq <= previousSampleSeq) {
        throw new Error("sample sequence is not strictly increasing");
      }
      previousMonoUs = sample.monotonicUs;
      previousSampleSeq = sample.sampleSeq;
      yield { kind: "sample", monotonicUs: sample.monotonicUs, frameSeq: entry.seq, sample };
    }
  }
}

async function* anchorEvents(
  source: ReplayableBinaryFrameSource,
): AsyncGenerator<TimedBinaryEvent> {
  let previousFrameSeq = -1;
  let previousMonoUs: bigint | null = null;
  let runId: string | null = null;
  for await (const entry of source.frames()) {
    const frame = parseFrame(entry.bytes);
    assertFrameOrder(frame, entry, previousFrameSeq, runId);
    previousFrameSeq = entry.seq;
    runId ??= frame.header.runIdHex;
    if (frame.header.type !== FrameType.ClockAnchor) continue;
    const anchor = parseClockAnchor(frame.payload);
    if (previousMonoUs !== null && anchor.monotonicUs < previousMonoUs) {
      throw new Error("clock anchors regress across frame sequence order");
    }
    previousMonoUs = anchor.monotonicUs;
    yield { kind: "anchor", monotonicUs: anchor.monotonicUs, frameSeq: entry.seq, anchor };
  }
}

async function* gapEvents(
  source: ReplayableBinaryFrameSource,
): AsyncGenerator<TimedBinaryEvent> {
  let previousFrameSeq = -1;
  let previousStartUs: bigint | null = null;
  let runId: string | null = null;
  for await (const entry of source.gapFrames()) {
    const frame = parseFrame(entry.bytes);
    if (frame.header.frameSeq !== entry.seq) throw new Error("staged frame sequence mismatch");
    if (frame.header.type !== FrameType.Gap) throw new Error("GAP source contains a non-GAP frame");
    if (runId !== null && frame.header.runIdHex !== runId) {
      throw new Error("binary session contains mixed run ids");
    }
    const gap = parseGap(frame.payload);
    if (
      previousStartUs !== null &&
      (gap.monotonicStartUs < previousStartUs ||
        (gap.monotonicStartUs === previousStartUs && entry.seq <= previousFrameSeq))
    ) {
      throw new Error("GAP source is not chronologically ordered");
    }
    previousFrameSeq = entry.seq;
    previousStartUs = gap.monotonicStartUs;
    runId ??= frame.header.runIdHex;
    yield { kind: "gap", monotonicUs: gap.monotonicStartUs, frameSeq: entry.seq, gap };
  }
}

async function* mergeTimedEvents(
  iterators: AsyncGenerator<TimedBinaryEvent>[],
): AsyncGenerator<TimedBinaryEvent> {
  const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
  try {
    for (;;) {
      let selected = -1;
      for (let index = 0; index < heads.length; index++) {
        if (heads[index]!.done) continue;
        if (
          selected === -1 ||
          compareEvents(heads[index]!.value, heads[selected]!.value) < 0
        ) {
          selected = index;
        }
      }
      if (selected === -1) return;
      yield heads[selected]!.value;
      heads[selected] = await iterators[selected]!.next();
    }
  } finally {
    await Promise.all(iterators.map((iterator) => iterator.return(undefined)));
  }
}

/** Assemble deterministic MCAP bytes while retaining at most one raw input frame per pass. */
export async function assembleBinaryMcap(
  source: ReplayableBinaryFrameSource,
  info: BinarySessionInfo,
  writable?: IWritable,
): Promise<Uint8Array | null> {
  const scan = await scanSource(source, info);
  const projection = scan.projection;
  const project = (monoUs: bigint): bigint => {
    return projectTimestampU64(monoUs, projection.offsetNs ?? 0n);
  };

  const droppedSamples = Math.max(scan.end?.droppedSamples ?? 0, scan.maxDroppedSamples);
  const droppedFrames = Math.max(scan.end?.droppedFrames ?? 0, scan.maxDroppedFrames);
  const corruptFrames = Math.max(scan.end?.corruptFrames ?? 0, scan.maxCorruptFrames);
  const backpressureEvents = Math.max(
    scan.end?.backpressureEvents ?? 0,
    scan.maxBackpressureEvents,
  );
  const retryAttempts = Math.max(scan.end?.retryAttempts ?? 0, scan.maxRetryAttempts);
  const complete =
    scan.end !== null &&
    info.sequenceComplete === true &&
    droppedSamples === 0 &&
    droppedFrames === 0 &&
    corruptFrames === 0 &&
    scan.gapCount === 0 &&
    scan.end.encodedSamples === scan.sampleCount;

  const mem = writable ? null : new MemoryWritable();
  const writer = new McapWriter({
    writable: writable ?? mem!,
    useChunks: true,
    chunkSize: 1 << 20,
    useChunkIndex: true,
    useStatistics: true,
    useSummaryOffsets: true,
    useMetadataIndex: true,
  });
  await writer.start({ profile: "", library: LIBRARY });
  const metadata = new Map<string, string>([
    ["device", info.device],
    ["session", info.session],
    ["run_id", info.session],
    ["mesh_path", info.meshPath],
    ["wire_format", "alloy-device-wire/1"],
    ["firmware", scan.begin.firmware],
    ["mission", scan.begin.mission],
    ["reliability_tier", String(scan.begin.reliabilityTier)],
    ["utc_anchored", String(projection.offsetNs !== null)],
    ["clock_quality", projection.quality],
    ["projection_anchor_id", projection.anchorId === null ? "" : String(projection.anchorId)],
    ["frame_count", String(scan.frameCount)],
    ["sample_count", String(scan.sampleCount)],
    ["attempted_samples", String(scan.end?.attemptedSamples ?? scan.sampleCount)],
    ["end_observed", String(scan.end !== null)],
    ["sequence_complete", String(info.sequenceComplete === true)],
    ["reported_dropped_samples", String(droppedSamples)],
    ["reported_dropped_frames", String(droppedFrames)],
    ["reported_corrupt_frames", String(corruptFrames)],
    ["backpressure_events", String(backpressureEvents)],
    ["retry_attempts", String(retryAttempts)],
    ["maximum_backlog_slots", String(scan.maximumBacklogSlots)],
    ["journal_capacity_slots", String(scan.journalCapacitySlots)],
    ["gap_sample_count", scan.gapSampleCount],
    ["gap_frame_count", scan.gapFrameCount],
    ["complete", String(complete)],
  ]);
  if (scan.caps) {
    metadata.set("board", scan.caps.boardName || String(scan.caps.board));
    metadata.set("adapter_revision", String(scan.caps.boardRevision));
    metadata.set("core", scan.caps.coreName);
    metadata.set("radio", scan.caps.radioName);
    metadata.set("capability_bits", scan.caps.capabilityBits.toString());
  }
  await writer.addMetadata({ name: "alloy", metadata });

  const channelIds = new Map<string, number>();
  const channelSequences = new Map<number, number>();
  for (const entry of scan.schemaEntries.sort((a, b) => a.seq - b.seq)) {
    const schema = entry.schema;
    const id = await writer.registerSchema({
      name: `${schema.channel}_r${schema.revision}_scalars`,
      encoding: "jsonschema",
      data: enc.encode(JSON.stringify(buildBinarySchema(schema))),
    });
    const channelId = await writer.registerChannel({
      topic: `/${schema.channel}`,
      messageEncoding: "json",
      schemaId: id,
      metadata: new Map([
        ["device", info.device],
        ["session", info.session],
        ["alloy_schema_id", String(schema.id)],
        ["alloy_schema_revision", String(schema.revision)],
      ]),
    });
    channelIds.set(schemaKey(schema.id, schema.revision), channelId);
    channelSequences.set(channelId, 0);
  }

  let anchorChannelId: number | null = null;
  if (projection.offsetNs !== null) {
    const schemaId = await writer.registerSchema({
      name: "alloy_clock_anchor",
      encoding: "jsonschema",
      data: enc.encode(JSON.stringify(anchorSchema)),
    });
    anchorChannelId = await writer.registerChannel({
      topic: "/alloy/clock_anchor",
      messageEncoding: "json",
      schemaId,
      metadata: new Map(),
    });
  }

  let gapChannelId: number | null = null;
  if (scan.gapCount > 0) {
    const schemaId = await writer.registerSchema({
      name: "alloy_gap",
      encoding: "jsonschema",
      data: enc.encode(JSON.stringify(gapSchema)),
    });
    gapChannelId = await writer.registerChannel({
      topic: "/alloy/gap",
      messageEncoding: "json",
      schemaId,
      metadata: new Map(),
    });
  }

  // Each category is independently sequence/monotonic ordered at acceptance. Merge one decoded
  // event from each replayable iterator so MCAP messages stay chronologically ordered without a
  // whole-session event array.
  const iterators: AsyncGenerator<TimedBinaryEvent>[] = [sampleEvents(source, scan.schemas)];
  if (anchorChannelId !== null) iterators.push(anchorEvents(source));
  if (gapChannelId !== null) iterators.push(gapEvents(source));
  let anchorSequence = 0;
  let gapSequence = 0;
  for await (const event of mergeTimedEvents(iterators)) {
    const timestamp = project(event.monotonicUs);
    if (event.kind === "sample") {
      const sample = event.sample;
      const channelId = channelIds.get(schemaKey(sample.schemaId, sample.schemaRevision));
      if (channelId === undefined) throw new Error("sample channel was not registered");
      const sequence = channelSequences.get(channelId)!;
      channelSequences.set(channelId, sequence + 1);
      await writer.addMessage({
        channelId,
        sequence,
        logTime: timestamp,
        publishTime: timestamp,
        data: enc.encode(JSON.stringify({
          ...sample.values,
          _alloy_mono_us: sample.monotonicUs.toString(),
          _alloy_anchor_id: sample.anchorId,
          _alloy_sample_seq: sample.sampleSeq,
          _alloy_utc_anchored: projection.offsetNs !== null,
        })),
      });
    } else if (event.kind === "anchor") {
      const anchor = event.anchor;
      const residual = anchor.utcNs - timestamp;
      await writer.addMessage({
        channelId: anchorChannelId!,
        sequence: anchorSequence++,
        logTime: timestamp,
        publishTime: timestamp,
        data: enc.encode(JSON.stringify({
          anchor_id: anchor.id,
          source: anchor.source,
          quality: anchor.quality,
          uncertainty_us: anchor.uncertaintyUs,
          monotonic_us: anchor.monotonicUs.toString(),
          utc_ns: anchor.utcNs.toString(),
          frequency_error_ppb: anchor.frequencyErrorPpb,
          residual_ns: residual.toString(),
        })),
      });
    } else {
      const gap = event.gap;
      project(gap.monotonicEndUs); // validate the full retained GAP interval, not only its logTime
      await writer.addMessage({
        channelId: gapChannelId!,
        sequence: gapSequence++,
        logTime: timestamp,
        publishTime: timestamp,
        data: enc.encode(JSON.stringify({
          reason: gap.reason,
          action: gap.action,
          first_lost_sample_seq: gap.firstLostSampleSeq,
          lost_sample_count: gap.lostSampleCount,
          first_lost_frame_seq: gap.firstLostFrameSeq,
          lost_frame_count: gap.lostFrameCount,
          monotonic_start_us: gap.monotonicStartUs.toString(),
          monotonic_end_us: gap.monotonicEndUs.toString(),
          detail: gap.detail,
        })),
      });
    }
  }

  await writer.end();
  return mem ? mem.toUint8Array() : null;
}
