import { FrameType, crc32c, type BinarySchema } from "../src/binary";

export const TEST_RUN_ID = Uint8Array.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);
export const TEST_RUN_HEX = "00112233445566778899aabbccddeeff";

const enc = new TextEncoder();

export function makeFrame(
  type: FrameType,
  payload: Uint8Array,
  options: {
    seq?: number;
    runId?: Uint8Array;
    journalUsed?: number;
    journalCapacity?: number;
    droppedSamples?: number;
    droppedFrames?: number;
    corruptFrames?: number;
    backpressureEvents?: number;
    retryAttempts?: number;
  } = {},
): Uint8Array {
  const bytes = new Uint8Array(64 + payload.byteLength);
  bytes.set([0x41, 0x4c, 0x59, 0x31, 1, type], 0);
  bytes.set(options.runId ?? TEST_RUN_ID, 16);
  bytes.set(payload, 64);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 64, true);
  view.setUint16(10, payload.byteLength, true);
  view.setUint32(12, options.seq ?? 0, true);
  view.setUint16(32, options.journalUsed ?? 1, true);
  view.setUint16(34, options.journalCapacity ?? 4, true);
  view.setUint32(36, options.droppedSamples ?? 0, true);
  view.setUint32(40, options.droppedFrames ?? 0, true);
  view.setUint32(44, options.corruptFrames ?? 0, true);
  view.setUint32(48, options.backpressureEvents ?? 0, true);
  view.setUint32(52, options.retryAttempts ?? 0, true);
  view.setUint32(60, crc32c(bytes, 60, 4), true);
  return bytes;
}

export function beginPayload(options: {
  device?: string;
  firmware?: string;
  mission?: string;
  tier?: number;
  monoStartUs?: bigint;
} = {}): Uint8Array {
  const device = enc.encode(options.device ?? "uno-r4");
  const firmware = enc.encode(options.firmware ?? "test-fw");
  const mission = enc.encode(options.mission ?? "bench run");
  const payload = new Uint8Array(16 + device.length + firmware.length + mission.length);
  payload.set([device.length, firmware.length, mission.length, options.tier ?? 1, 1], 0);
  new DataView(payload.buffer).setBigUint64(8, options.monoStartUs ?? 100n, true);
  payload.set(device, 16);
  payload.set(firmware, 16 + device.length);
  payload.set(mission, 16 + device.length + firmware.length);
  return payload;
}

export const TEST_SCHEMA: BinarySchema = {
  id: 1,
  revision: 1,
  flags: 0,
  channel: "env",
  fields: [
    { id: 0, type: 8, flags: 0, name: "temp_c", unit: "degC" },
    { id: 1, type: 1, flags: 0, name: "healthy", unit: "" },
  ],
};

export function schemaPayload(schema = TEST_SCHEMA): Uint8Array {
  const channel = enc.encode(schema.channel);
  const fields = schema.fields.map((field) => ({
    field,
    name: enc.encode(field.name),
    unit: enc.encode(field.unit),
  }));
  const size = 8 + channel.length + fields.reduce((n, f) => n + 6 + f.name.length + f.unit.length, 0);
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  view.setUint16(0, schema.id, true);
  view.setUint16(2, schema.revision, true);
  payload[4] = channel.length;
  payload[5] = fields.length;
  payload.set(channel, 8);
  let offset = 8 + channel.length;
  for (const { field, name, unit } of fields) {
    payload.set([field.id, field.type, field.flags, name.length, unit.length, 0], offset);
    offset += 6;
    payload.set(name, offset);
    offset += name.length;
    payload.set(unit, offset);
    offset += unit.length;
  }
  return payload;
}

export function samplesPayload(options: {
  baseUs?: bigint;
  rows?: { deltaUs: number; sampleSeq: number; anchorId?: number; temp: number; healthy: boolean }[];
} = {}): Uint8Array {
  const rows = options.rows ?? [
    { deltaUs: 0, sampleSeq: 1, anchorId: 0, temp: 22.5, healthy: true },
    { deltaUs: 10, sampleSeq: 2, anchorId: 0, temp: 23.25, healthy: false },
  ];
  const recordBytes = 25;
  const payload = new Uint8Array(16 + rows.length * recordBytes);
  const view = new DataView(payload.buffer);
  view.setUint16(0, rows.length, true);
  view.setBigUint64(4, options.baseUs ?? 900n, true);
  view.setUint16(12, 20, true);
  let offset = 16;
  for (const row of rows) {
    view.setUint16(offset, recordBytes, true);
    view.setUint16(offset + 2, 1, true);
    view.setUint16(offset + 4, 1, true);
    view.setUint16(offset + 6, row.anchorId ?? 0, true);
    view.setUint32(offset + 8, row.sampleSeq, true);
    view.setUint32(offset + 12, row.deltaUs, true);
    view.setUint16(offset + 16, 3, true);
    view.setFloat32(offset + 20, row.temp, true);
    view.setUint8(offset + 24, row.healthy ? 1 : 0);
    offset += recordBytes;
  }
  return payload;
}

export function anchorPayload(options: {
  id?: number;
  monoUs?: bigint;
  utcNs?: bigint;
  quality?: number;
} = {}): Uint8Array {
  const payload = new Uint8Array(32);
  const view = new DataView(payload.buffer);
  view.setUint16(0, options.id ?? 1, true);
  payload[2] = 1;
  payload[3] = options.quality ?? 2;
  view.setUint32(4, 1000, true);
  view.setBigUint64(8, options.monoUs ?? 1000n, true);
  view.setBigUint64(16, options.utcNs ?? 1_700_000_000_000_000_000n, true);
  view.setInt32(24, -2147483648, true);
  return payload;
}

export function gapPayload(): Uint8Array {
  const payload = new Uint8Array(40);
  const view = new DataView(payload.buffer);
  payload[0] = 1;
  payload[1] = 1;
  view.setUint32(4, 3, true);
  view.setUint32(8, 2, true);
  view.setBigUint64(20, 920n, true);
  view.setBigUint64(28, 930n, true);
  return payload;
}

export function endPayload(options: {
  monoEndUs?: bigint;
  attemptedSamples?: number;
  encodedSamples?: number;
  droppedSamples?: number;
  droppedFrames?: number;
  corruptFrames?: number;
  backpressureEvents?: number;
  retryAttempts?: number;
} = {}): Uint8Array {
  const payload = new Uint8Array(40);
  const view = new DataView(payload.buffer);
  payload[0] = 1;
  view.setBigUint64(4, options.monoEndUs ?? 1100n, true);
  view.setUint32(12, options.attemptedSamples ?? 4, true);
  view.setUint32(16, options.encodedSamples ?? 2, true);
  view.setUint32(20, options.droppedSamples ?? 2, true);
  view.setUint32(24, options.droppedFrames ?? 0, true);
  view.setUint32(28, options.corruptFrames ?? 0, true);
  view.setUint32(32, options.backpressureEvents ?? 0, true);
  view.setUint32(36, options.retryAttempts ?? 0, true);
  return payload;
}
