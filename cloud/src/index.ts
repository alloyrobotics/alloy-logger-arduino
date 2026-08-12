// Worker entry — validates, authenticates, and routes device traffic to the session DO.
// One POST per sealed device buffer; the DO does everything stateful.

import { authenticate, sha256Hex } from "./auth";
import {
  AckDetail,
  AckFlag,
  AckStatus,
  BodyTooLargeError,
  type AckContext,
  FrameType,
  WIRE_MAX_FRAME_BYTES,
  ackContext,
  encodeAck,
  normalizeRunId,
  parseFrame,
  readBoundedBody,
  statusForWireError,
  validateStatelessPayload,
} from "./binary";
import type { Env } from "./types";

export { SessionDO } from "./session-do";

const MAX_CHUNK_BYTES = 64 * 1024; // device buffers are 12KB — generous headroom
const MAX_META_BYTES = 16 * 1024;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/; // device + channel (device sanitizes these already)
const DEVICE_V2_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SESSION_RE = /^\d{1,12}$/; // epoch seconds
const MESH_RE = /^[A-Za-z0-9_\/-]{1,128}$/;

function bad(msg: string): Response {
  return new Response(msg, { status: 400 });
}

function binaryAckResponse(
  context: AckContext,
  status: AckStatus,
  httpStatus: number,
  flags = 0,
  retryAfterMs = 0,
): Response {
  return new Response(
    encodeAck({
      status,
      flags,
      detail: AckDetail.None,
      ackSeq: context.ackSeq,
      lowestMissingSeq: 0,
      retryAfterMs,
      runId: context.runId,
      requestCrc32c: context.requestCrc32c,
    }),
    {
      status: httpStatus,
      headers: {
        "Content-Type": "application/vnd.alloy.ack;version=1",
        "Cache-Control": "no-store",
        "X-Alloy-Server-UTC-Ns": (BigInt(Date.now()) * 1_000_000n).toString(),
        ...(retryAfterMs > 0
          ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
          : {}),
      },
    },
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/v1/health") return Response.json({ ok: true });

    if (url.pathname === "/v2/frame") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

      const declaredLength = req.headers.get("Content-Length");
      if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        if (BigInt(declaredLength) > BigInt(WIRE_MAX_FRAME_BYTES)) {
          return new Response("frame too large", { status: 413 });
        }
      }
      let body: Uint8Array;
      try {
        body = await readBoundedBody(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return new Response("frame too large", { status: 413 });
        throw error;
      }
      const context = ackContext(body);
      let frame;
      try {
        frame = parseFrame(body);
      } catch (error) {
        return context
          ? binaryAckResponse(context, statusForWireError(error), 400)
          : bad(error instanceof Error ? error.message : "malformed binary frame");
      }

      const contentType = req.headers.get("Content-Type") ?? "";
      if (!/^application\/vnd\.alloy\.frame\s*;\s*version=1$/i.test(contentType)) {
        return binaryAckResponse(context!, AckStatus.ProtocolFormatConflict, 415);
      }
      try {
        validateStatelessPayload(frame);
      } catch {
        return binaryAckResponse(
          context!,
          frame.header.type === FrameType.Samples
            ? AckStatus.InvalidSample
            : AckStatus.ProtocolFormatConflict,
          400,
        );
      }

      const apiKey = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!apiKey) return binaryAckResponse(context!, AckStatus.AuthenticationFailure, 401);
      const device = req.headers.get("X-Alloy-Device") ?? "";
      const run = normalizeRunId(req.headers.get("X-Alloy-Run") ?? "");
      const meshPath = (req.headers.get("X-Alloy-Mesh-Path") ?? "").replace(/^\/+|\/+$/g, "");
      if (
        !DEVICE_V2_RE.test(device) ||
        !run ||
        !MESH_RE.test(meshPath) ||
        frame.header.runIdHex !== run
      ) {
        return binaryAckResponse(context!, AckStatus.IdentityConflict, 400);
      }
      const finalizeMs = req.headers.get("X-Alloy-Finalize-Ms");
      if (finalizeMs !== null && !/^\d{4,8}$/.test(finalizeMs)) {
        return binaryAckResponse(context!, AckStatus.ProtocolFormatConflict, 400);
      }

      let authenticated: boolean;
      try {
        authenticated = await authenticate(env, apiKey, meshPath);
      } catch (error) {
        console.error(`Alloy auth oracle unavailable: ${String(error)}`);
        return binaryAckResponse(
          context!,
          AckStatus.Busy,
          503,
          AckFlag.Retryable,
          5000,
        );
      }
      if (!authenticated) {
        return binaryAckResponse(context!, AckStatus.AuthenticationFailure, 401);
      }
      const keyHash = await sha256Hex(apiKey);
      const id = env.SESSION_DO.idFromName(`${keyHash}:${device}:${run}`);
      const headers = new Headers(req.headers);
      headers.delete("Content-Length");
      headers.set("X-Alloy-Run", run);
      headers.set("X-Alloy-Mesh-Path", meshPath);
      headers.set("X-Internal-Key-Hash", keyHash);
      return env.SESSION_DO.get(id).fetch(
        new Request(req.url, { method: "POST", headers, body }),
      );
    }

    if (!["/v1/chunk", "/v1/meta", "/v1/end"].includes(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const apiKey = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!apiKey) return new Response("missing bearer", { status: 401 });

    const device = req.headers.get("X-Alloy-Device") ?? "";
    const session = req.headers.get("X-Alloy-Session") ?? "";
    const meshPath = (req.headers.get("X-Alloy-Mesh-Path") ?? "").replace(/^\/+|\/+$/g, "");
    if (!NAME_RE.test(device)) return bad("bad X-Alloy-Device");
    if (!SESSION_RE.test(session)) return bad("bad X-Alloy-Session");
    if (!MESH_RE.test(meshPath)) return bad("bad X-Alloy-Mesh-Path");

    const finalizeMs = req.headers.get("X-Alloy-Finalize-Ms");
    if (finalizeMs !== null && !/^\d{4,8}$/.test(finalizeMs)) return bad("bad X-Alloy-Finalize-Ms");

    const len = Number(req.headers.get("Content-Length") ?? "0");
    if (url.pathname === "/v1/chunk") {
      const channel = req.headers.get("X-Alloy-Channel") ?? "";
      const seq = req.headers.get("X-Alloy-Seq") ?? "";
      if (!NAME_RE.test(channel)) return bad("bad X-Alloy-Channel");
      if (!/^\d{1,9}$/.test(seq)) return bad("bad X-Alloy-Seq");
      if (len > MAX_CHUNK_BYTES) return new Response("chunk too large", { status: 413 });
    } else if (url.pathname === "/v1/meta" && len > MAX_META_BYTES) {
      return new Response("meta too large", { status: 413 });
    }

    let authenticated: boolean;
    try {
      authenticated = await authenticate(env, apiKey, meshPath);
    } catch (error) {
      console.error(`Alloy auth oracle unavailable: ${String(error)}`);
      return new Response("Alloy authentication temporarily unavailable", {
        status: 503,
        headers: { "Retry-After": "5" },
      });
    }
    if (!authenticated) {
      return new Response("invalid api key", { status: 401 });
    }

    const keyHash = await sha256Hex(apiKey);
    const id = env.SESSION_DO.idFromName(`${keyHash}:${device}:${session}`);
    const stub = env.SESSION_DO.get(id);
    const fwd = new Request(req, { headers: new Headers(req.headers) });
    fwd.headers.set("X-Internal-Key-Hash", keyHash);
    return stub.fetch(fwd);
  },
} satisfies ExportedHandler<Env>;
