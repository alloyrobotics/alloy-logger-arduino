// Alloy Device Wire v1 parsing/encoding. All multibyte integers are little-endian.
// Keep this module free of Workers bindings so the exact wire contract can be unit-tested.

export const WIRE_VERSION = 1;
export const WIRE_HEADER_BYTES = 64;
export const WIRE_MAX_FRAME_BYTES = 1024;
export const WIRE_ACK_BYTES = 48;
export const U64_MAX = 0xffff_ffff_ffff_ffffn;

export enum FrameType {
  Begin = 1,
  Capabilities = 2,
  Schema = 3,
  ClockAnchor = 4,
  Samples = 5,
  Gap = 6,
  End = 7,
}

export enum FieldType {
  Bool = 1,
  I8 = 2,
  U8 = 3,
  I16 = 4,
  U16 = 5,
  I32 = 6,
  U32 = 7,
  F32 = 8,
  F64 = 9,
}

export enum AckStatus {
  Accepted = 0,
  Duplicate = 1,
  BadMagic = 2,
  BadVersion = 3,
  BadLength = 4,
  BadCrc = 5,
  RunNotStarted = 6,
  RunFinalized = 7,
  SequenceConflict = 8,
  UnknownSchema = 9,
  SchemaConflict = 10,
  InvalidSample = 11,
  AuthenticationFailure = 12,
  RateLimited = 13,
  Busy = 14,
  InternalError = 15,
  IdentityConflict = 16,
  ProtocolFormatConflict = 17,
}

export enum AckFlag {
  Accepted = 1 << 0,
  Duplicate = 1 << 1,
  Retryable = 1 << 2,
  RunTerminal = 1 << 3,
}

export enum AckDetail {
  None = 0,
}

export enum GapReason {
  JournalFull = 1,
  EncodeError = 2,
  ClockRegression = 3,
  JournalCrcFailure = 4,
  ResetRecovery = 5,
  EndDrainTimeout = 6,
}

export enum GapAction {
  DropNewest = 1,
  WouldBlock = 2,
  Faulted = 3,
}

export enum EndReason {
  Explicit = 1,
}

export interface FrameHeader {
  type: FrameType;
  frameSeq: number;
  runId: Uint8Array;
  runIdHex: string;
  journalUsed: number;
  journalCapacity: number;
  droppedSamples: number;
  droppedFrames: number;
  corruptFrames: number;
  backpressureEvents: number;
  retryCount: number;
  crc32c: number;
}

export interface WireFrame {
  header: FrameHeader;
  payload: Uint8Array;
  bytes: Uint8Array;
}

export interface BeginPayload {
  device: string;
  firmware: string;
  mission: string;
  reliabilityTier: number;
  bootReason: number;
  monotonicStartUs: bigint;
}

export interface CapabilitiesPayload {
  board: number;
  boardRevision: number;
  capabilityBits: bigint;
  maxFrameBytes: number;
  journalSlots: number;
  journalSlotBytes: number;
  maxSchemas: number;
  maxFields: number;
  journalKind: number;
  reliabilityTier: number;
  monotonicResolutionUs: number;
  scheduler: number;
  boardName: string;
  coreName: string;
  radioName: string;
}

export interface BinaryField {
  id: number;
  type: FieldType;
  flags: number;
  name: string;
  unit: string;
}

export interface BinarySchema {
  id: number;
  revision: number;
  flags: number;
  channel: string;
  fields: BinaryField[];
}

export interface ClockAnchor {
  id: number;
  source: number;
  quality: number;
  uncertaintyUs: number;
  monotonicUs: bigint;
  utcNs: bigint;
  frequencyErrorPpb: number;
}

export interface GapPayload {
  reason: GapReason;
  action: GapAction;
  firstLostSampleSeq: number;
  lostSampleCount: number;
  firstLostFrameSeq: number;
  lostFrameCount: number;
  monotonicStartUs: bigint;
  monotonicEndUs: bigint;
  detail: number;
}

export interface EndPayload {
  reason: EndReason;
  flags: number;
  monotonicEndUs: bigint;
  attemptedSamples: number;
  encodedSamples: number;
  droppedSamples: number;
  droppedFrames: number;
  corruptFrames: number;
  backpressureEvents: number;
  retryAttempts: number;
}

export interface AckOptions {
  status: AckStatus;
  flags: number;
  detail?: AckDetail;
  ackSeq: number;
  lowestMissingSeq: number;
  retryAfterMs?: number;
  runId: Uint8Array;
  requestCrc32c: number;
}

export interface BinarySample {
  schemaId: number;
  schemaRevision: number;
  anchorId: number;
  sampleSeq: number;
  monotonicUs: bigint;
  presentMask: number;
  values: Record<string, boolean | number>;
}

export interface SamplesPayload {
  baseMonotonicUs: bigint;
  samples: BinarySample[];
}

export class WireError extends Error {
  constructor(
    message: string,
    readonly detail = 0,
  ) {
    super(message);
    this.name = "WireError";
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("frame too large");
    this.name = "BodyTooLargeError";
  }
}

/** Read at most max+1 bytes from the actual stream; Content-Length is never trusted as the bound. */
export async function readBoundedBody(
  request: Request,
  maxBytes = WIRE_MAX_FRAME_BYTES,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body exceeds Alloy Device Wire maximum").catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0x82f63b78 : 0);
    table[i] = c >>> 0;
  }
  return table;
})();

/** Reflected CRC32C (Castagnoli), initial/final XOR 0xffffffff. */
export function crc32c(bytes: Uint8Array, zeroFrom = -1, zeroLength = 0): number {
  let crc = 0xffffffff;
  const zeroTo = zeroFrom + zeroLength;
  for (let i = 0; i < bytes.byteLength; i++) {
    const value = i >= zeroFrom && i < zeroTo ? 0 : bytes[i];
    crc = crcTable[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Project a monotonic microsecond value into MCAP's unsigned 64-bit nanosecond domain. */
export function projectTimestampU64(monotonicUs: bigint, offsetNs = 0n): bigint {
  const projected = monotonicUs * 1000n + offsetNs;
  if (projected < 0n || projected > U64_MAX) {
    throw new WireError("timestamp projection is outside the u64 range");
  }
  return projected;
}

function requireRange(bytes: Uint8Array, offset: number, length: number, what: string): void {
  if (length < 0 || offset < 0 || offset + length > bytes.byteLength) {
    throw new WireError(`${what} is truncated`);
  }
}

function decodeText(
  bytes: Uint8Array,
  offset: number,
  length: number,
  what: string,
): string {
  requireRange(bytes, offset, length, what);
  try {
    const value = textDecoder.decode(bytes.subarray(offset, offset + length));
    if (/\p{Cc}/u.test(value)) throw new Error("control character");
    return value;
  } catch {
    throw new WireError(`${what} is not valid UTF-8 text`);
  }
}

function isFrameType(value: number): value is FrameType {
  return value >= FrameType.Begin && value <= FrameType.End;
}

export function runIdHex(runId: Uint8Array): string {
  if (runId.byteLength !== 16) throw new WireError("run id must be 16 bytes");
  return [...runId].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HTTP binding uses the canonical lowercase 32-hex representation. */
export function normalizeRunId(value: string): string | null {
  return /^[0-9a-f]{32}$/.test(value) ? value : null;
}

export interface AckContext {
  ackSeq: number;
  runId: Uint8Array;
  requestCrc32c: number;
}

/** Extract only ACK echo fields from a complete fixed header, even when validation later fails. */
export function ackContext(bytes: Uint8Array): AckContext | null {
  if (bytes.byteLength < WIRE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ackSeq: view.getUint32(12, true),
    runId: bytes.slice(16, 32),
    requestCrc32c: view.getUint32(60, true),
  };
}

export function statusForWireError(error: unknown): AckStatus {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("magic")) return AckStatus.BadMagic;
  if (message.includes("version")) return AckStatus.BadVersion;
  if (message.includes("CRC32C")) return AckStatus.BadCrc;
  if (message.includes("length") || message.includes("truncated") || message.includes("too large")) {
    return AckStatus.BadLength;
  }
  return AckStatus.ProtocolFormatConflict;
}

/**
 * Parse and fully validate the fixed envelope. Payload-specific validation is performed by the
 * parse* helpers below (Samples additionally needs the pinned schema registry).
 */
export function parseFrame(bytes: Uint8Array): WireFrame {
  if (bytes.byteLength > WIRE_MAX_FRAME_BYTES) throw new WireError("frame too large");
  if (bytes.byteLength < WIRE_HEADER_BYTES) throw new WireError("frame header is truncated");
  if (bytes[0] !== 0x41 || bytes[1] !== 0x4c || bytes[2] !== 0x59 || bytes[3] !== 0x31) {
    throw new WireError("bad frame magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[4] !== WIRE_VERSION) throw new WireError("unsupported frame version");
  if (!isFrameType(bytes[5]!)) throw new WireError("unknown frame type");
  if (view.getUint16(6, true) !== 0) throw new WireError("frame flags must be zero");
  if (view.getUint16(8, true) !== WIRE_HEADER_BYTES) throw new WireError("bad header length");
  const payloadLength = view.getUint16(10, true);
  if (WIRE_HEADER_BYTES + payloadLength !== bytes.byteLength) {
    throw new WireError("declared payload length does not match body");
  }
  if (view.getUint32(56, true) !== 0) throw new WireError("reserved header bytes must be zero");
  const expectedCrc = view.getUint32(60, true);
  if (crc32c(bytes, 60, 4) !== expectedCrc) throw new WireError("frame CRC32C mismatch");

  const journalUsed = view.getUint16(32, true);
  const journalCapacity = view.getUint16(34, true);
  if (journalUsed > journalCapacity) throw new WireError("journal usage exceeds capacity");
  if (view.getUint32(12, true) === 0xffff_ffff) {
    throw new WireError("maximum frame sequence is reserved");
  }
  const id = bytes.slice(16, 32);
  if (id.every((b) => b === 0)) throw new WireError("run id must not be zero");

  return {
    header: {
      type: bytes[5]!,
      frameSeq: view.getUint32(12, true),
      runId: id,
      runIdHex: runIdHex(id),
      journalUsed,
      journalCapacity,
      droppedSamples: view.getUint32(36, true),
      droppedFrames: view.getUint32(40, true),
      corruptFrames: view.getUint32(44, true),
      backpressureEvents: view.getUint32(48, true),
      retryCount: view.getUint32(52, true),
      crc32c: expectedCrc,
    },
    payload: bytes.subarray(WIRE_HEADER_BYTES),
    bytes,
  };
}

export function parseBegin(payload: Uint8Array): BeginPayload {
  if (payload.byteLength < 16) throw new WireError("BEGIN payload is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const deviceLength = payload[0]!;
  const firmwareLength = payload[1]!;
  const missionLength = payload[2]!;
  if (deviceLength === 0 || deviceLength > 32) throw new WireError("bad BEGIN device length");
  if (firmwareLength > 32) throw new WireError("bad BEGIN firmware length");
  if (missionLength > 64) throw new WireError("bad BEGIN mission length");
  if (payload[5] !== 0 || payload[6] !== 0 || payload[7] !== 0) {
    throw new WireError("BEGIN reserved bytes must be zero");
  }
  if (payload[3]! < 1 || payload[3]! > 3) throw new WireError("bad BEGIN reliability tier");
  if (payload.byteLength !== 16 + deviceLength + firmwareLength + missionLength) {
    throw new WireError("bad BEGIN payload length");
  }
  let offset = 16;
  const device = decodeText(payload, offset, deviceLength, "BEGIN device");
  offset += deviceLength;
  if (!NAME_RE.test(device)) throw new WireError("bad BEGIN device");
  const firmware = decodeText(payload, offset, firmwareLength, "BEGIN firmware");
  offset += firmwareLength;
  const mission = decodeText(payload, offset, missionLength, "BEGIN mission");
  return {
    device,
    firmware,
    mission,
    reliabilityTier: payload[3]!,
    bootReason: payload[4]!,
    monotonicStartUs: view.getBigUint64(8, true),
  };
}

export function parseCapabilities(payload: Uint8Array): CapabilitiesPayload {
  if (payload.byteLength < 32) throw new WireError("CAPS payload is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const boardLength = payload[25]!;
  const coreLength = payload[26]!;
  const radioLength = payload[27]!;
  if (boardLength > 32 || coreLength > 24 || radioLength > 24) {
    throw new WireError("bad CAPS string length");
  }
  if (payload.byteLength !== 32 + boardLength + coreLength + radioLength) {
    throw new WireError("bad CAPS payload length");
  }
  if (view.getUint32(28, true) !== 0) throw new WireError("CAPS reserved bytes must be zero");
  const maxFrameBytes = view.getUint16(12, true);
  const journalSlots = view.getUint16(14, true);
  const journalSlotBytes = view.getUint16(16, true);
  const maxSchemas = payload[18]!;
  const maxFields = payload[19]!;
  if (maxFrameBytes < WIRE_HEADER_BYTES || maxFrameBytes > WIRE_MAX_FRAME_BYTES) {
    throw new WireError("bad CAPS maximum frame size");
  }
  if (journalSlots === 0 || journalSlotBytes < WIRE_HEADER_BYTES || journalSlotBytes > maxFrameBytes) {
    throw new WireError("bad CAPS journal bounds");
  }
  if (maxSchemas === 0 || maxFields === 0 || maxFields > 16) {
    throw new WireError("bad CAPS schema bounds");
  }
  if (payload[20]! > 3 || payload[21]! < 1 || payload[21]! > 3) {
    throw new WireError("bad CAPS journal kind or reliability tier");
  }
  if (payload[24]! < 1 || payload[24]! > 2) throw new WireError("bad CAPS scheduler kind");
  let offset = 32;
  const boardName = decodeText(payload, offset, boardLength, "CAPS board name");
  offset += boardLength;
  const coreName = decodeText(payload, offset, coreLength, "CAPS core name");
  offset += coreLength;
  const radioName = decodeText(payload, offset, radioLength, "CAPS radio name");
  return {
    board: view.getUint16(0, true),
    boardRevision: view.getUint16(2, true),
    capabilityBits: view.getBigUint64(4, true),
    maxFrameBytes,
    journalSlots,
    journalSlotBytes,
    maxSchemas,
    maxFields,
    journalKind: payload[20]!,
    reliabilityTier: payload[21]!,
    monotonicResolutionUs: view.getUint16(22, true),
    scheduler: payload[24]!,
    boardName,
    coreName,
    radioName,
  };
}

export function fieldWidth(type: FieldType): number {
  switch (type) {
    case FieldType.Bool:
    case FieldType.I8:
    case FieldType.U8:
      return 1;
    case FieldType.I16:
    case FieldType.U16:
      return 2;
    case FieldType.I32:
    case FieldType.U32:
    case FieldType.F32:
      return 4;
    case FieldType.F64:
      return 8;
    default:
      throw new WireError("unknown schema field type");
  }
}

export function parseSchema(payload: Uint8Array): BinarySchema {
  if (payload.byteLength < 8) throw new WireError("SCHEMA payload is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const id = view.getUint16(0, true);
  const revision = view.getUint16(2, true);
  const channelLength = payload[4]!;
  const fieldCount = payload[5]!;
  const flags = view.getUint16(6, true);
  if (channelLength === 0 || channelLength > 24) throw new WireError("bad SCHEMA channel length");
  if (fieldCount > 16) throw new WireError("bad SCHEMA field count");
  if (flags !== 0) throw new WireError("SCHEMA flags must be zero");
  let offset = 8;
  const channel = decodeText(payload, offset, channelLength, "SCHEMA channel");
  offset += channelLength;
  if (!NAME_RE.test(channel)) throw new WireError("bad SCHEMA channel");
  const fields: BinaryField[] = [];
  const ids = new Set<number>();
  const names = new Set<string>();
  for (let index = 0; index < fieldCount; index++) {
    requireRange(payload, offset, 6, "SCHEMA field descriptor");
    const fieldId = payload[offset]!;
    const type = payload[offset + 1]! as FieldType;
    const fieldFlags = payload[offset + 2]!;
    const nameLength = payload[offset + 3]!;
    const unitLength = payload[offset + 4]!;
    if (payload[offset + 5] !== 0) throw new WireError("SCHEMA field reserved byte must be zero");
    if (fieldId !== index || ids.has(fieldId)) throw new WireError("field ids must be contiguous");
    fieldWidth(type);
    if (fieldFlags !== 0) throw new WireError("SCHEMA field flags must be zero");
    if (nameLength === 0 || nameLength > 24 || unitLength > 12) {
      throw new WireError("bad SCHEMA field string length");
    }
    offset += 6;
    const name = decodeText(payload, offset, nameLength, "SCHEMA field name");
    offset += nameLength;
    const unit = decodeText(payload, offset, unitLength, "SCHEMA field unit");
    offset += unitLength;
    if (!NAME_RE.test(name) || name.startsWith("_alloy_") || names.has(name)) {
      throw new WireError("bad or duplicate field name");
    }
    if (!/^[\x20-\x7e]*$/.test(unit)) throw new WireError("SCHEMA unit must be printable ASCII");
    ids.add(fieldId);
    names.add(name);
    fields.push({ id: fieldId, type, flags: fieldFlags, name, unit });
  }
  if (offset !== payload.byteLength) throw new WireError("SCHEMA payload has trailing bytes");
  return { id, revision, flags, channel, fields };
}

export function parseClockAnchor(payload: Uint8Array): ClockAnchor {
  if (payload.byteLength !== 32) throw new WireError("ANCHOR payload must be 32 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const id = view.getUint16(0, true);
  if (id === 0) throw new WireError("anchor id must not be zero");
  if (payload[2]! < 1 || payload[2]! > 4) throw new WireError("unknown ANCHOR source");
  if (payload[3]! < 1 || payload[3]! > 2) throw new WireError("unknown ANCHOR quality");
  if (view.getBigUint64(16, true) === 0n) throw new WireError("ANCHOR UTC must not be zero");
  if (view.getUint32(28, true) !== 0) throw new WireError("ANCHOR reserved bytes must be zero");
  return {
    id,
    source: payload[2]!,
    quality: payload[3]!,
    uncertaintyUs: view.getUint32(4, true),
    monotonicUs: view.getBigUint64(8, true),
    utcNs: view.getBigUint64(16, true),
    frequencyErrorPpb: view.getInt32(24, true),
  };
}

function readField(view: DataView, offset: number, type: FieldType): boolean | number {
  switch (type) {
    case FieldType.Bool: {
      const value = view.getUint8(offset);
      if (value > 1) throw new WireError("boolean sample value must be 0 or 1");
      return value === 1;
    }
    case FieldType.I8:
      return view.getInt8(offset);
    case FieldType.U8:
      return view.getUint8(offset);
    case FieldType.I16:
      return view.getInt16(offset, true);
    case FieldType.U16:
      return view.getUint16(offset, true);
    case FieldType.I32:
      return view.getInt32(offset, true);
    case FieldType.U32:
      return view.getUint32(offset, true);
    case FieldType.F32: {
      const value = view.getFloat32(offset, true);
      if (!Number.isFinite(value)) throw new WireError("non-finite f32 sample value");
      return value;
    }
    case FieldType.F64: {
      const value = view.getFloat64(offset, true);
      if (!Number.isFinite(value)) throw new WireError("non-finite f64 sample value");
      return value;
    }
  }
}

/** Validate a SAMPLES payload against schemas already pinned for this run. */
export function parseSamples(
  payload: Uint8Array,
  schemaFor: (id: number, revision: number) => BinarySchema | undefined,
): SamplesPayload {
  if (payload.byteLength < 16) throw new WireError("SAMPLES payload is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint16(0, true);
  if (count === 0 || count > 64) throw new WireError("bad SAMPLES count");
  if (view.getUint16(2, true) !== 0 || view.getUint16(14, true) !== 0) {
    throw new WireError("SAMPLES reserved bytes must be zero");
  }
  if (view.getUint16(12, true) !== 20) throw new WireError("bad SAMPLES record header size");
  const baseMonotonicUs = view.getBigUint64(4, true);
  const samples: BinarySample[] = [];
  let offset = 16;
  let previousDelta = -1;
  let previousSampleSeq = -1;
  for (let index = 0; index < count; index++) {
    requireRange(payload, offset, 20, "SAMPLES record header");
    const recordBytes = view.getUint16(offset, true);
    const schemaId = view.getUint16(offset + 2, true);
    const schemaRevision = view.getUint16(offset + 4, true);
    const anchorId = view.getUint16(offset + 6, true);
    const sampleSeq = view.getUint32(offset + 8, true);
    if (sampleSeq === 0xffff_ffff) throw new WireError("maximum sample sequence is reserved");
    const deltaUs = view.getUint32(offset + 12, true);
    const presentMask = view.getUint16(offset + 16, true);
    if (view.getUint16(offset + 18, true) !== 0) {
      throw new WireError("SAMPLES record reserved bytes must be zero");
    }
    if ((index === 0 && deltaUs !== 0) || deltaUs < previousDelta) {
      throw new WireError("SAMPLES deltas must start at zero and be nondecreasing");
    }
    if (sampleSeq <= previousSampleSeq) {
      throw new WireError("SAMPLES sample sequences must be strictly increasing");
    }
    previousDelta = deltaUs;
    previousSampleSeq = sampleSeq;
    const schema = schemaFor(schemaId, schemaRevision);
    if (!schema) throw new WireError(`unknown schema ${schemaId}/${schemaRevision}`);
    const valueBytes = schema.fields.reduce((sum, field) => sum + fieldWidth(field.type), 0);
    if (recordBytes !== 20 + valueBytes) throw new WireError("SAMPLES record length/schema mismatch");
    requireRange(payload, offset, recordBytes, "SAMPLES record");
    const allowedMask = schema.fields.reduce((mask, field) => mask | (1 << field.id), 0);
    if ((presentMask & ~allowedMask) !== 0) throw new WireError("SAMPLES present mask has unknown fields");
    // Field names are protocol data, not object-shape controls. In particular,
    // `__proto__` is a valid wire name and must be retained as an own property.
    const values: Record<string, boolean | number> = Object.create(null);
    let valueOffset = offset + 20;
    for (const field of schema.fields) {
      const width = fieldWidth(field.type);
      const present = (presentMask & (1 << field.id)) !== 0;
      if (!present) {
        for (let byte = 0; byte < width; byte++) {
          if (payload[valueOffset + byte] !== 0) {
            throw new WireError("absent SAMPLES field bytes must be zero");
          }
        }
      }
      const value = readField(view, valueOffset, field.type);
      if (present) values[field.name] = value;
      valueOffset += width;
    }
    const monotonicUs = baseMonotonicUs + BigInt(deltaUs);
    if (monotonicUs > U64_MAX) throw new WireError("SAMPLES absolute timestamp overflows u64");
    samples.push({
      schemaId,
      schemaRevision,
      anchorId,
      sampleSeq,
      monotonicUs,
      presentMask,
      values,
    });
    offset += recordBytes;
  }
  if (offset !== payload.byteLength) throw new WireError("SAMPLES payload has trailing bytes");
  return { baseMonotonicUs, samples };
}

/** Structural SAMPLES check usable at the stateless Worker edge before schema lookup in the DO. */
export function validateSamplesStructure(payload: Uint8Array): void {
  if (payload.byteLength < 16) throw new WireError("SAMPLES payload is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint16(0, true);
  if (count === 0 || count > 64) throw new WireError("bad SAMPLES count");
  if (view.getUint16(2, true) !== 0 || view.getUint16(12, true) !== 20 || view.getUint16(14, true) !== 0) {
    throw new WireError("bad SAMPLES prefix");
  }
  const baseMonotonicUs = view.getBigUint64(4, true);
  let offset = 16;
  let previousDelta = -1;
  let previousSampleSeq = -1;
  for (let index = 0; index < count; index++) {
    requireRange(payload, offset, 20, "SAMPLES record header");
    const recordBytes = view.getUint16(offset, true);
    if (recordBytes < 20) throw new WireError("bad SAMPLES record length");
    requireRange(payload, offset, recordBytes, "SAMPLES record");
    if (view.getUint16(offset + 18, true) !== 0) {
      throw new WireError("SAMPLES record reserved bytes must be zero");
    }
    const deltaUs = view.getUint32(offset + 12, true);
    const sampleSeq = view.getUint32(offset + 8, true);
    if (sampleSeq === 0xffff_ffff) throw new WireError("maximum sample sequence is reserved");
    if (baseMonotonicUs + BigInt(deltaUs) > U64_MAX) {
      throw new WireError("SAMPLES absolute timestamp overflows u64");
    }
    if ((index === 0 && deltaUs !== 0) || deltaUs < previousDelta) {
      throw new WireError("SAMPLES deltas must start at zero and be nondecreasing");
    }
    if (sampleSeq <= previousSampleSeq) {
      throw new WireError("SAMPLES sample sequences must be strictly increasing");
    }
    previousDelta = deltaUs;
    previousSampleSeq = sampleSeq;
    offset += recordBytes;
  }
  if (offset !== payload.byteLength) throw new WireError("SAMPLES payload has trailing bytes");
}

export function parseGap(payload: Uint8Array): GapPayload {
  if (payload.byteLength !== 40) throw new WireError("GAP payload must be 40 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const reason = payload[0]! as GapReason;
  const action = payload[1]! as GapAction;
  if (reason < GapReason.JournalFull || reason > GapReason.EndDrainTimeout) {
    throw new WireError("unknown GAP reason");
  }
  if (action < GapAction.DropNewest || action > GapAction.Faulted) {
    throw new WireError("unknown GAP action");
  }
  if (view.getUint16(2, true) !== 0) throw new WireError("GAP reserved bytes must be zero");
  const monotonicStartUs = view.getBigUint64(20, true);
  const monotonicEndUs = view.getBigUint64(28, true);
  if (monotonicEndUs < monotonicStartUs) throw new WireError("GAP time range is reversed");
  const lostSampleCount = view.getUint32(8, true);
  const lostFrameCount = view.getUint32(16, true);
  return {
    reason,
    action,
    firstLostSampleSeq: view.getUint32(4, true),
    lostSampleCount,
    firstLostFrameSeq: view.getUint32(12, true),
    lostFrameCount,
    monotonicStartUs,
    monotonicEndUs,
    detail: view.getUint32(36, true),
  };
}

export function parseEnd(payload: Uint8Array): EndPayload {
  if (payload.byteLength !== 40) throw new WireError("END payload must be 40 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const reason = payload[0]! as EndReason;
  if (reason !== EndReason.Explicit) {
    throw new WireError("unknown END reason");
  }
  if (payload[1] !== 0) throw new WireError("END reserved byte must be zero");
  if (view.getUint16(2, true) !== 0) throw new WireError("END flags must be zero in v1");
  return {
    reason,
    flags: view.getUint16(2, true),
    monotonicEndUs: view.getBigUint64(4, true),
    attemptedSamples: view.getUint32(12, true),
    encodedSamples: view.getUint32(16, true),
    droppedSamples: view.getUint32(20, true),
    droppedFrames: view.getUint32(24, true),
    corruptFrames: view.getUint32(28, true),
    backpressureEvents: view.getUint32(32, true),
    retryAttempts: view.getUint32(36, true),
  };
}

/** Encode the fixed 48-byte acknowledgement and protect it with the same CRC32C variant. */
export function encodeAck(options: AckOptions): Uint8Array {
  if (options.runId.byteLength !== 16) throw new WireError("ACK run id must be 16 bytes");
  const out = new Uint8Array(WIRE_ACK_BYTES);
  out.set([0x41, 0x4c, 0x59, 0x41, WIRE_VERSION, options.status], 0);
  out.set(options.runId, 24);
  const view = new DataView(out.buffer);
  view.setUint16(6, options.flags, true);
  view.setUint16(8, WIRE_ACK_BYTES, true);
  view.setUint16(10, options.detail ?? AckDetail.None, true);
  view.setUint32(12, options.ackSeq, true);
  view.setUint32(16, options.lowestMissingSeq, true);
  view.setUint32(20, options.retryAfterMs ?? 0, true);
  view.setUint32(44, options.requestCrc32c, true);
  view.setUint32(40, crc32c(out, 40, 4), true);
  return out;
}

/** Validate every payload shape that does not require run state. */
export function validateStatelessPayload(frame: WireFrame): void {
  switch (frame.header.type) {
    case FrameType.Begin:
      parseBegin(frame.payload);
      return;
    case FrameType.Capabilities:
      parseCapabilities(frame.payload);
      return;
    case FrameType.Schema:
      parseSchema(frame.payload);
      return;
    case FrameType.ClockAnchor:
      parseClockAnchor(frame.payload);
      return;
    case FrameType.Samples:
      validateSamplesStructure(frame.payload);
      return;
    // GAP and END are validated by their exact-layout parsers below once decoded.
    case FrameType.Gap:
      parseGap(frame.payload);
      return;
    case FrameType.End:
      parseEnd(frame.payload);
      return;
  }
}
