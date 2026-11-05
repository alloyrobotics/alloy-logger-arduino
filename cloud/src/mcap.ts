// CSV chunks -> one indexed MCAP. Pure (no Workers bindings) so it unit-tests in plain node.
//
// Messages are emitted in strictly non-decreasing log_time order via a k-way merge across the
// per-channel cursors (each cursor is already time-ordered, so the merge is exact). Payloads are
// JSON ("json" message encoding, "jsonschema" schema encoding) — self-describing and supported by
// every MCAP consumer. t_ns is NOT in the payload; it IS the record's logTime.

import { McapWriter } from "@mcap/core";
import type { IWritable } from "@mcap/core";
import { type ChunkSource, type CursorRow, rowsOf } from "./csv";
import type { DeviceMeta } from "./types";

export const LIBRARY = "alloylogger-cloud/0.1.0";

/** Growable in-memory IWritable. Sessions are 10s of MB; fine to hold while assembling. */
export class MemoryWritable implements IWritable {
  #buf = new Uint8Array(1 << 20);
  #pos = 0;

  position(): bigint {
    return BigInt(this.#pos);
  }

  async write(b: Uint8Array): Promise<void> {
    if (this.#pos + b.byteLength > this.#buf.byteLength) {
      let cap = this.#buf.byteLength * 2;
      while (cap < this.#pos + b.byteLength) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.#buf.subarray(0, this.#pos));
      this.#buf = next;
    }
    this.#buf.set(b, this.#pos);
    this.#pos += b.byteLength;
  }

  toUint8Array(): Uint8Array {
    return this.#buf.subarray(0, this.#pos);
  }
}

export interface SessionInfo {
  device: string;
  session: string; // epoch seconds as string
  meshPath: string;
}

/** JSON Schema for one channel generation, folding in describe() semantics from meta.json. */
export function buildSchema(
  channel: string,
  fields: string[],
  meta: DeviceMeta | null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const d = meta?.fields?.find((m) => m.channel === channel && m.name === f);
    const parts: string[] = [];
    if (d?.unit) parts.push(d.unit);
    if (d?.about) parts.push(d.about);
    if (d && (d.min !== undefined || d.max !== undefined)) {
      parts.push(`range ${d.min ?? "?"}..${d.max ?? "?"}`);
    }
    // Plain "number", not ["number","null"]: MCAP JSON consumers (Foxglove convention,
    // Alloy replay viewer) treat `type` as a single string — a union array reads as null.
    // Absent readings are encoded by OMITTING the key, which plain "number" permits.
    const prop: Record<string, unknown> = { type: "number" };
    if (parts.length) prop.description = parts.join("; ");
    if (d?.min !== undefined) prop.minimum = d.min;
    if (d?.max !== undefined) prop.maximum = d.max;
    properties[f] = prop;
  }
  return { type: "object", properties };
}

/**
 * Assemble one indexed MCAP from per-channel chunk sources.
 * Returns the bytes when no `writable` is given; otherwise streams into it and returns null.
 */
export async function assembleMcap(
  sources: ChunkSource[],
  meta: DeviceMeta | null,
  info: SessionInfo,
  writable?: IWritable,
): Promise<Uint8Array | null> {
  const mem = writable ? null : new MemoryWritable();
  const writer = new McapWriter({
    writable: writable ?? mem!,
    useChunks: true,
    chunkSize: 1 << 20,
    useChunkIndex: true,
    useStatistics: true,
    useSummaryOffsets: true,
    useMetadataIndex: true,
    // no compressChunk: uncompressed chunks keep this pure JS (no wasm codecs)
  });
  const enc = new TextEncoder();

  await writer.start({ profile: "", library: LIBRARY });

  const sessionMeta = new Map<string, string>([
    ["device", info.device],
    ["session", info.session],
    ["mesh_path", info.meshPath],
  ]);
  if (meta?.firmware) sessionMeta.set("firmware", meta.firmware);
  if (meta?.mission) sessionMeta.set("mission", meta.mission);
  if (meta?.session) sessionMeta.set("session_iso", meta.session);
  await writer.addMetadata({ name: "alloy", metadata: sessionMeta });

  // k-way merge on tNs. Linear scan per pop: the device caps concurrent channels at 8
  // (ALLOY_MAX_CHANNELS), so a heap buys nothing.
  const iters = sources.map((s) => rowsOf(s));
  const heads: (CursorRow | null)[] = [];
  for (const it of iters) {
    const r = await it.next();
    heads.push(r.done ? null : r.value);
  }

  const channelIds = new Map<string, number>(); // "channel\0generation" -> mcap channel id
  const seqs = new Map<number, number>();

  for (;;) {
    let mi = -1;
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (h && (mi < 0 || h.tNs < heads[mi]!.tNs)) mi = i;
    }
    if (mi < 0) break;
    const row = heads[mi]!;

    const key = `${row.channel}\x00${row.generation}`;
    let channelId = channelIds.get(key);
    if (channelId === undefined) {
      // "_scalars" suffix is load-bearing: Alloy's replay viewer (alloy-rerun
      // suggest.rs classify_schema) picks a TimeSeries view for a channel only if the
      // schema NAME contains float/int32/uint/scalar — without it the plot stays empty.
      const schemaId = await writer.registerSchema({
        name: `${row.channel}_scalars`,
        encoding: "jsonschema",
        data: enc.encode(JSON.stringify(buildSchema(row.channel, row.fields, meta))),
      });
      channelId = await writer.registerChannel({
        topic: `/${row.channel}`,
        messageEncoding: "json",
        schemaId,
        metadata: new Map([
          ["device", info.device],
          ["session", info.session],
        ]),
      });
      channelIds.set(key, channelId);
      seqs.set(channelId, 0);
    }

    const obj: Record<string, number> = {};
    for (let j = 0; j < row.fields.length; j++) {
      const v = row.values[j];
      if (v !== null) obj[row.fields[j]] = v; // omit absent readings, don't write null
    }
    const sequence = seqs.get(channelId)!;
    seqs.set(channelId, sequence + 1);
    await writer.addMessage({
      channelId,
      sequence,
      logTime: row.tNs,
      publishTime: row.tNs,
      data: enc.encode(JSON.stringify(obj)),
    });

    const next = await iters[mi].next();
    heads[mi] = next.done ? null : next.value;
  }

  await writer.end();
  return mem ? mem.toUint8Array() : null;
}
