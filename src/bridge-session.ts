// Long-lived bridge session: owns the subprocess, performs the handshake,
// dispatches inbound envelopes, and keeps a narrow per-conversation cache for
// `session.snapshot`. Structured so the OpenClaw plugin runtime can
// start/stop one session per configured Mutiro account.

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  attachEnvelopeReader,
  type BridgeClient,
  type BridgeLogger,
  createBridgeClient,
  createHostProcess,
} from "./bridge-client.js";
import {
  buildSyntheticBridgeMessage,
  cloneMessage,
  trimRecentMessages,
} from "./bridge-messages.js";
import {
  DEFAULT_OPTIONAL_CAPABILITIES,
  MAX_RECENT_MESSAGES,
  TYPE_URLS,
  type BridgeEnvelope,
} from "./bridge-protocol.js";
import { deliverObservedEnvelope, type InboundDeliver } from "./inbound.js";
import { createMutiroOutbound, type MutiroOutbound } from "./outbound.js";

export type LiveToolHint = {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
};

export type LiveSnapshot = {
  systemInstruction?: string;
  recentMessages?: unknown[];
  promptData?: Record<string, string>;
  toolHints?: LiveToolHint[];
  metadata?: Record<string, string>;
};

/**
 * Invoked when the host requests `session.snapshot` for a voice call
 * handoff. Lets the plugin supply the agent's system prompt, real
 * transcript, and tool hints so the live model starts with the same
 * persona the chat agent has. Resolver may return `undefined` fields to
 * fall back to the bridge's cached synthetic state.
 */
export type LiveSnapshotResolver = (params: {
  conversationId: string;
  accountId: string;
  callId?: string;
  username?: string;
}) => Promise<LiveSnapshot | null | undefined>;

/**
 * Invoked when the host sends a `task.request`. The brain should run the
 * delegated prompt against OpenClaw's agent and return the accumulated
 * reply text, which the bridge ships back to the host as the
 * `ChatBridgeTaskResult.text`. Implementations should honor the
 * `timeoutMs` window when provided — returning whatever text has
 * accumulated so far is preferable to throwing.
 */
export type TaskRequestResolver = (params: {
  conversationId: string;
  accountId: string;
  username?: string;
  prompt: string;
  promptData?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  requestId?: string;
}) => Promise<string>;

export type BridgeSessionOptions = {
  accountId: string;
  agentDir: string;
  clientName?: string;
  clientVersion?: string;
  requestedOptionalCapabilities?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: BridgeLogger;
  deliver: InboundDeliver;
  resolveLiveSnapshot?: LiveSnapshotResolver;
  resolveTaskRequest?: TaskRequestResolver;
  onHostExit?: (code: number | null) => void;
};

type ConversationState = {
  recentMessages: unknown[];
};

const consoleLogger: BridgeLogger = {
  info: (msg) => console.log(`[openclaw-mutiro] ${msg}`),
  warn: (msg) => console.warn(`[openclaw-mutiro] ${msg}`),
  error: (msg) => console.error(`[openclaw-mutiro] ${msg}`),
};

export type BridgeSession = {
  accountId: string;
  host: ChildProcessWithoutNullStreams;
  bridge: BridgeClient;
  outbound: MutiroOutbound;
  getAgentUsername: () => string;
  shutdown: () => Promise<void>;
};

export const startBridgeSession = async (
  options: BridgeSessionOptions,
): Promise<BridgeSession> => {
  const logger = options.logger ?? consoleLogger;
  const host = createHostProcess({
    agentDir: options.agentDir,
    env: options.env,
    logger,
    onExit: options.onHostExit,
  });

  const bridge = createBridgeClient(host);
  const outbound = createMutiroOutbound(bridge);
  const conversations = new Map<string, ConversationState>();
  let agentUsername = "";

  const getConversation = (conversationId: string) => {
    const existing = conversations.get(conversationId);
    if (existing) return existing;
    const state: ConversationState = { recentMessages: [] };
    conversations.set(conversationId, state);
    return state;
  };

  const appendRecent = (conversationId: string, message: unknown) => {
    if (!message || typeof message !== "object") return;
    const state = getConversation(conversationId);
    state.recentMessages.push(cloneMessage(message));
    state.recentMessages = trimRecentMessages(state.recentMessages, MAX_RECENT_MESSAGES);
  };

  const initializeBridge = async () => {
    // Standalone bridge mode mirrors the documented handshake:
    // ready → session.initialize → subscription.set → message.observed.
    logger.info("host ready, sending initialization");
    await bridge.request("session.initialize", {
      "@type": TYPE_URLS.bridgeInitializeCommand,
      role: "brain",
      client_name: options.clientName ?? "openclaw-mutiro-bridge",
      client_version: options.clientVersion ?? "1.0.0",
      requested_optional_capabilities:
        options.requestedOptionalCapabilities ?? DEFAULT_OPTIONAL_CAPABILITIES,
    });
    logger.info("subscribing to event stream");
    await bridge.request("subscription.set", {
      "@type": TYPE_URLS.bridgeSubscriptionSetCommand,
      all: true,
      conversation_ids: [],
    });
    logger.info("handshake complete, listening for messages");
  };

  const handleObservedMessage = async (envelope: BridgeEnvelope) => {
    if (envelope.type === "message.observed") {
      // Ack delivery immediately so the host knows we accepted the turn, even
      // though the actual visible reply will happen later via message.send.
      bridge.ack(envelope.request_id!, TYPE_URLS.bridgeMessageObservedResult);
    }

    const turn = await deliverObservedEnvelope(envelope, {
      accountId: options.accountId,
      agentUsername,
      deliver: options.deliver,
    });

    if (!turn) {
      if (envelope.conversation_id && envelope.message_id) {
        outbound.endTurn({
          conversationId: envelope.conversation_id,
          replyToMessageId: envelope.message_id,
        });
      }
      return;
    }

    appendRecent(turn.conversationId, (envelope.payload as { message?: unknown })?.message);
  };

  const handleTaskRequest = async (envelope: BridgeEnvelope) => {
    // ChatBridgeTaskRequest fields (see spec/protobuf/shared/chat_bridge.proto):
    //   conversation_id, username, prompt, prompt_data, metadata, timeout_ms.
    // The response MUST carry the agent's reply text inside
    // ChatBridgeTaskResult; unlike message.observed there is no secondary
    // message.send path — the host waits for this command_result.
    const payload = (envelope.payload ?? {}) as {
      conversation_id?: string;
      username?: string;
      prompt?: string;
      prompt_data?: Record<string, string>;
      metadata?: Record<string, string>;
      timeout_ms?: number | string;
    };
    const conversationId =
      payload.conversation_id || envelope.conversation_id || "task-queue";
    const prompt = (payload.prompt ?? "").trim();

    const timeoutMs =
      typeof payload.timeout_ms === "number"
        ? payload.timeout_ms
        : typeof payload.timeout_ms === "string"
          ? Number.parseInt(payload.timeout_ms, 10) || undefined
          : undefined;

    let resultText = "";
    if (!prompt) {
      logger.warn("task.request arrived without a prompt; returning empty result");
    } else if (!options.resolveTaskRequest) {
      logger.warn("task.request received but no resolveTaskRequest is configured");
    } else {
      try {
        resultText = await options.resolveTaskRequest({
          conversationId,
          accountId: options.accountId,
          username: payload.username,
          prompt,
          promptData: payload.prompt_data,
          metadata: payload.metadata,
          timeoutMs,
          requestId: envelope.request_id,
        });
      } catch (err) {
        logger.error(
          `task.request resolver failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        resultText = "";
      }
    }

    bridge.send(
      "command_result",
      {
        "@type": TYPE_URLS.bridgeCommandResult,
        ok: true,
        response: {
          "@type": TYPE_URLS.bridgeTaskResult,
          text: resultText,
        },
      },
      {
        request_id: envelope.request_id,
        conversation_id: conversationId,
      },
    );
  };

  const handleSessionSnapshot = async (envelope: BridgeEnvelope) => {
    const payload = (envelope.payload ?? {}) as {
      conversation_id?: string;
      username?: string;
      call_id?: string;
    };
    const conversationId = payload.conversation_id || envelope.conversation_id;
    logger.info(
      `session.snapshot requested: conversation_id=${conversationId ?? ""} call_id=${payload.call_id ?? ""} username=${payload.username ?? ""}`,
    );
    if (!conversationId) {
      bridge.sendError(envelope.request_id, "invalid_request", "session.snapshot conversation_id is required");
      return;
    }

    const cached = conversations.get(conversationId);

    // Ask the plugin runtime to build a rich snapshot. The resolver may
    // return the real agent system prompt, the real session transcript, and
    // channel-owned tool hints so the live voice model starts with the same
    // persona the chat brain has. Any undefined field falls back to cached
    // synthetic state so an offline/missing resolver degrades gracefully.
    let snapshot: LiveSnapshot | null | undefined;
    if (options.resolveLiveSnapshot) {
      try {
        snapshot = await options.resolveLiveSnapshot({
          conversationId,
          accountId: options.accountId,
          callId: payload.call_id,
          username: payload.username,
        });
      } catch (err) {
        logger.warn(
          `session.snapshot resolver failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        snapshot = null;
      }
    }

    const response: Record<string, unknown> = {
      "@type": TYPE_URLS.bridgeSessionSnapshotResult,
      recent_messages: snapshot?.recentMessages ?? cached?.recentMessages ?? [],
      metadata: {
        conversation_id: conversationId,
        ...(snapshot?.metadata ?? {}),
      },
    };
    if (snapshot?.systemInstruction && snapshot.systemInstruction.trim()) {
      response.system_instruction = snapshot.systemInstruction;
    }
    if (snapshot?.promptData && Object.keys(snapshot.promptData).length > 0) {
      response.prompt_data = snapshot.promptData;
    }
    if (snapshot?.toolHints && snapshot.toolHints.length > 0) {
      response.tool_hints = snapshot.toolHints.map((hint) => ({
        name: hint.name,
        description: hint.description ?? "",
        metadata: hint.metadata ?? {},
      }));
    }

    bridge.send(
      "command_result",
      {
        "@type": TYPE_URLS.bridgeCommandResult,
        ok: true,
        response,
      },
      {
        request_id: envelope.request_id,
        conversation_id: conversationId,
      },
    );
  };

  const handleSessionObserved = async (envelope: BridgeEnvelope) => {
    const payload = (envelope.payload ?? {}) as {
      conversation_id?: string;
      text?: string;
      source?: string;
    };
    const conversationId = payload.conversation_id || envelope.conversation_id;
    if (!conversationId) {
      bridge.sendError(envelope.request_id, "invalid_request", "session.observed conversation_id is required");
      return;
    }

    const observedText = (payload.text || "").trim();
    if (observedText) {
      appendRecent(
        conversationId,
        buildSyntheticBridgeMessage({
          conversationId,
          senderUsername: "system",
          text: observedText,
          metadata: { source: (payload.source || "").trim() },
        }),
      );
    }

    bridge.ack(envelope.request_id!, TYPE_URLS.bridgeSessionObservedResult);
  };

  attachEnvelopeReader(
    host,
    async (envelope) => {
      switch (envelope.type) {
        case "ready": {
          const payload = (envelope.payload ?? {}) as { agent_username?: string };
          agentUsername = payload.agent_username || agentUsername;
          try {
            await initializeBridge();
          } catch (err) {
            logger.error(
              `handshake failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        case "command_result":
          bridge.resolveResponse(envelope.request_id, envelope.payload);
          return;
        case "error":
          if (!bridge.rejectResponse(envelope.request_id, envelope.error)) {
            logger.error(`host error: ${JSON.stringify(envelope.error)}`);
          }
          return;
        case "message.observed":
        case "event.message":
          await handleObservedMessage(envelope);
          return;
        case "task.request":
          await handleTaskRequest(envelope);
          return;
        case "session.snapshot":
          await handleSessionSnapshot(envelope);
          return;
        case "session.observed":
          await handleSessionObserved(envelope);
          return;
        default:
          if (envelope.request_id) {
            bridge.sendError(
              envelope.request_id,
              "unsupported_envelope",
              `unsupported envelope type ${JSON.stringify(envelope.type)}`,
              {
                conversation_id: envelope.conversation_id,
                message_id: envelope.message_id,
                reply_to_message_id: envelope.reply_to_message_id,
              },
            );
          }
      }
    },
    logger,
  );

  const shutdown = async () => {
    try {
      bridge.send("host.shutdown", { "@type": "type.googleapis.com/mutiro.chatbridge.ChatBridgeShutdownCommand" });
    } catch {
      // best-effort
    }
    host.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (host.exitCode !== null) resolve();
      else host.once("exit", () => resolve());
    });
  };

  return {
    accountId: options.accountId,
    host,
    bridge,
    outbound,
    getAgentUsername: () => agentUsername,
    shutdown,
  };
};
