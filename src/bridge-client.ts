// NDJSON envelope codec + subprocess manager for the Mutiro chatbridge.
// Kept transport-shaped so the rest of the plugin can treat the bridge as a
// request/response channel regardless of which brain is on the other side.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

import {
  type BridgeEnvelope,
  type BridgeExtras,
  type PendingRequest,
  PROTOCOL_VERSION,
  TYPE_URLS,
  generateId,
} from "./bridge-protocol.js";

export type BridgeLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

const defaultLogger: BridgeLogger = {
  info: (msg) => console.log(`[openclaw-mutiro] ${msg}`),
  warn: (msg) => console.warn(`[openclaw-mutiro] ${msg}`),
  error: (msg) => console.error(`[openclaw-mutiro] ${msg}`),
};

export type HostProcessOptions = {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  logger?: BridgeLogger;
  onExit?: (code: number | null) => void;
};

// In bridge mode the Mutiro host writes slog JSON records to stderr. Parse
// each line and route it through the OpenClaw channel logger so the output
// matches the rest of the gateway's log stream instead of leaking the raw
// Go-side format.
const HOST_ATTR_DROP = new Set(["time", "level", "msg", "component", "agent_username"]);

const formatAttrValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

type NormalizedHostLog = { level: "info" | "warn" | "error"; text: string };

const normalizeHostLogLine = (raw: string): NormalizedHostLog => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed.msg === "string") {
        const rawLevel = typeof parsed.level === "string" ? parsed.level.toLowerCase() : "info";
        const level: NormalizedHostLog["level"] =
          rawLevel === "error"
            ? "error"
            : rawLevel === "warn" || rawLevel === "warning"
              ? "warn"
              : "info";
        const attrs = Object.entries(parsed)
          .filter(([key]) => !HOST_ATTR_DROP.has(key))
          .map(([key, value]) => `${key}=${formatAttrValue(value)}`)
          .filter((entry) => entry.length > `=`.length + 1);
        const detail = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
        return { level, text: `host: ${parsed.msg}${detail}` };
      }
    } catch {
      // fall through to raw passthrough
    }
  }
  return { level: "info", text: `host: ${trimmed}` };
};

export const createHostProcess = (options: HostProcessOptions) => {
  const logger = options.logger ?? defaultLogger;
  const hostProcess = spawn("mutiro", ["agent", "host", "--mode=bridge"], {
    cwd: options.agentDir,
    env: options.env ?? process.env,
  });

  const stderrReader = readline.createInterface({
    input: hostProcess.stderr,
    terminal: false,
  });
  stderrReader.on("line", (line) => {
    if (!line.trim()) return;
    const { level, text } = normalizeHostLogLine(line);
    if (level === "error") logger.error(text);
    else if (level === "warn") logger.warn(text);
    else logger.info(text);
  });

  hostProcess.on("exit", (code) => {
    stderrReader.close();
    logger.info(`mutiro host exited with code ${code}`);
    options.onExit?.(code ?? null);
  });

  return hostProcess;
};

export type BridgeClient = {
  send: (type: string, payload: unknown, extras?: BridgeExtras) => void;
  request: <T = unknown>(type: string, payload: unknown, extras?: BridgeExtras) => Promise<T>;
  ack: (requestId: string, payloadType: string) => void;
  resolveResponse: (requestId: string | undefined, payload: unknown) => boolean;
  rejectResponse: (requestId: string | undefined, error: unknown) => boolean;
  sendError: (
    requestId: string | undefined,
    code: string,
    message: string,
    extras?: BridgeExtras,
  ) => void;
};

export const createBridgeClient = (
  hostProcess: ChildProcessWithoutNullStreams,
): BridgeClient => {
  // Bridge requests are ordinary NDJSON envelopes with request/response
  // correlation on request_id. Visible chat replies are *not* the response to
  // message.observed; they are separate outbound bridge requests.
  const pendingRequests = new Map<string, PendingRequest>();

  const send = (type: string, payload: unknown, extras: BridgeExtras = {}) => {
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      type,
      request_id: extras.request_id || generateId(),
      payload,
      ...extras,
    };
    hostProcess.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  const request = <T = unknown>(type: string, payload: unknown, extras: BridgeExtras = {}) =>
    new Promise<T>((resolve, reject) => {
      const requestId = generateId();
      pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      send(type, payload, { ...extras, request_id: requestId });
    });

  const ack = (requestId: string, payloadType: string) => {
    // Acknowledge host-owned request delivery. This is separate from sending a
    // user-visible message back into Mutiro.
    send(
      "command_result",
      {
        "@type": TYPE_URLS.bridgeCommandResult,
        ok: true,
        response: { "@type": payloadType },
      },
      { request_id: requestId },
    );
  };

  const resolveResponse = (requestId: string | undefined, payload: unknown) => {
    if (!requestId || !pendingRequests.has(requestId)) return false;
    const pending = pendingRequests.get(requestId)!;
    const resolved =
      payload && typeof payload === "object" && "response" in (payload as Record<string, unknown>)
        ? (payload as { response: unknown }).response
        : payload;
    pending.resolve(resolved);
    pendingRequests.delete(requestId);
    return true;
  };

  const rejectResponse = (requestId: string | undefined, error: unknown) => {
    if (!requestId || !pendingRequests.has(requestId)) return false;
    pendingRequests.get(requestId)!.reject(error);
    pendingRequests.delete(requestId);
    return true;
  };

  const sendError = (
    requestId: string | undefined,
    code: string,
    message: string,
    extras: BridgeExtras = {},
  ) => {
    if (!requestId) return;
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      type: "error",
      request_id: requestId,
      error: { code, message },
      ...extras,
    };
    hostProcess.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  return {
    ack,
    rejectResponse,
    request,
    resolveResponse,
    send,
    sendError,
  };
};

export type EnvelopeHandler = (envelope: BridgeEnvelope) => void | Promise<void>;

export const attachEnvelopeReader = (
  hostProcess: ChildProcessWithoutNullStreams,
  handler: EnvelopeHandler,
  logger: BridgeLogger = defaultLogger,
) => {
  const rl = readline.createInterface({ input: hostProcess.stdout, terminal: false });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const envelope = JSON.parse(line) as BridgeEnvelope;
      await handler(envelope);
    } catch (err) {
      logger.error(`error processing bridge line: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return rl;
};
