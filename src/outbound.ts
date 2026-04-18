// Outbound adapter that translates OpenClaw reply-dispatch calls into
// bridge-local commands. Mirrors pi-brain's tool surface (send_message,
// send_voice_message, send_card, react_to_message, send_file_message,
// forward_message, recall, recall_get) but reshaped so OpenClaw's
// ChannelOutboundAdapter is the consumer instead of a Pi tool runtime.

import * as path from "node:path";

import type { BridgeClient } from "./bridge-client.js";
import { applyVoiceLanguage, normalizeOutputText } from "./bridge-messages.js";
import { TYPE_URLS } from "./bridge-protocol.js";

export type MutiroOutboundTarget = {
  conversationId: string;
  replyToMessageId: string;
};

export type MutiroOutbound = {
  sendText: (
    target: MutiroOutboundTarget,
    text: string,
  ) => Promise<unknown>;
  sendVoice: (
    target: MutiroOutboundTarget,
    params: { toUsername: string; speech: string; language?: string },
  ) => Promise<unknown>;
  sendCard: (
    target: MutiroOutboundTarget,
    params: { components: unknown[]; data?: Record<string, unknown>; cardId?: string },
  ) => Promise<unknown>;
  sendCardJsonl: (
    target: MutiroOutboundTarget,
    params: { jsonl: string; version?: string; cardId?: string },
  ) => Promise<unknown>;
  sendFile: (
    target: MutiroOutboundTarget,
    params: { filePath: string; caption?: string },
  ) => Promise<unknown>;
  react: (params: { messageId: string; emoji: string }) => Promise<unknown>;
  forward: (params: {
    messageId: string;
    // Destination is a `oneof` in ForwardMessageRequest: exactly one of
    // `targetConversationId` or `toUsername` must be set.
    targetConversationId?: string;
    toUsername?: string;
    comment?: string;
  }) => Promise<unknown>;
  recallSearch: (params: {
    query: string;
    conversationId?: string;
    maxResults?: number;
  }) => Promise<unknown>;
  recallGet: (params: { entryId: string; conversationId?: string }) => Promise<unknown>;
  endTurn: (target: MutiroOutboundTarget) => void;
  emitSignal: (
    target: MutiroOutboundTarget,
    signalType: string,
    detailText?: string,
  ) => void;
};

const DEFAULT_VOICE = "en-US-Chirp3-HD-Orus";

const buildCardJson = (
  components: Array<Record<string, unknown>>,
  data?: Record<string, unknown>,
  cardId?: string,
) => {
  let rootId = (components[0] as { id?: string } | undefined)?.id || "root";
  for (const component of components) {
    const c = component as { parentId?: string; parent_id?: string; id?: string };
    if (!c.parentId && !c.parent_id) {
      rootId = c.id || rootId;
      break;
    }
  }

  const lines: string[] = [
    JSON.stringify({
      surfaceUpdate: {
        surfaceId: "main",
        components,
        clearBefore: true,
      },
    }),
  ];

  if (data) {
    const contents = Object.keys(data).map((key) => ({
      key,
      valueString:
        typeof data[key] === "object" ? JSON.stringify(data[key]) : String(data[key]),
    }));
    lines.push(
      JSON.stringify({
        dataModelUpdate: {
          surfaceId: "main",
          contents,
        },
      }),
    );
  }

  lines.push(
    JSON.stringify({
      beginRendering: {
        surfaceId: "main",
        root: rootId,
      },
    }),
  );

  return {
    // Field names must match Mutiro's CardPart protobuf schema (see
    // spec/protobuf/shared/messaging.proto). pi-brain uses stale names
    // (`json_data` / `version`) which the host's strict JSON-to-proto
    // decoder rejects as unknown fields.
    a2ui_json: lines.join("\n"),
    schema_version: "0.8",
    card_id: cardId || `openclaw-card-${Math.random().toString(36).slice(2, 10)}`,
  };
};

export const createMutiroOutbound = (bridge: BridgeClient): MutiroOutbound => {
  const extras = (target: MutiroOutboundTarget) => ({
    conversation_id: target.conversationId,
    reply_to_message_id: target.replyToMessageId,
  });

  return {
    sendText: async (target, text) => {
      const normalized = normalizeOutputText(text);
      if (!normalized) return { ok: false, reason: "noop" };
      return bridge.request(
        "message.send",
        {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: target.conversationId,
          reply_to_message_id: target.replyToMessageId,
          text: { text: normalized },
        },
        extras(target),
      );
    },

    sendVoice: async (target, params) => {
      const normalized = normalizeOutputText(params.speech);
      if (!normalized) return { ok: false, reason: "noop" };
      const voiceName = params.language
        ? applyVoiceLanguage(DEFAULT_VOICE, params.language)
        : DEFAULT_VOICE;
      return bridge.request(
        "message.send_voice",
        {
          "@type": TYPE_URLS.bridgeSendVoiceMessageCommand,
          to_username: params.toUsername.replace(/^@/, ""),
          speech: normalized,
          voice_name: voiceName,
          reply_to_message_id: target.replyToMessageId,
        },
        extras(target),
      );
    },

    sendCard: async (target, params) => {
      return bridge.request(
        "message.send",
        {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: target.conversationId,
          reply_to_message_id: target.replyToMessageId,
          parts: {
            parts: [
              {
                card: buildCardJson(
                  params.components as Array<Record<string, unknown>>,
                  params.data,
                  params.cardId,
                ),
              },
            ],
          },
        },
        extras(target),
      );
    },

    // Ship pre-built A2UI JSONL (same format the canvas tool's a2ui_push
    // action emits). Skips the components-to-JSONL conversion entirely, so
    // the agent can reuse its canvas mental model verbatim.
    sendCardJsonl: async (target, params) => {
      const jsonl = (params.jsonl ?? "").trim();
      if (!jsonl) return { ok: false, reason: "empty_jsonl" };
      return bridge.request(
        "message.send",
        {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: target.conversationId,
          reply_to_message_id: target.replyToMessageId,
          parts: {
            parts: [
              {
                card: {
                  a2ui_json: jsonl,
                  schema_version: params.version ?? "0.8",
                  card_id:
                    params.cardId || `openclaw-card-${Math.random().toString(36).slice(2, 10)}`,
                },
              },
            ],
          },
        },
        extras(target),
      );
    },

    sendFile: async (target, params) => {
      const uploadRes = (await bridge.request(
        "media.upload",
        {
          "@type": TYPE_URLS.bridgeMediaUploadCommand,
          local_path: params.filePath,
          filename: path.basename(params.filePath),
          mime_type: "application/octet-stream",
        },
        extras(target),
      )) as { media?: unknown } | null;

      if (!uploadRes?.media) {
        throw new Error(`failed to upload media: ${JSON.stringify(uploadRes)}`);
      }

      return bridge.request(
        "message.send",
        {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: target.conversationId,
          reply_to_message_id: target.replyToMessageId,
          parts: {
            parts: [
              {
                file: uploadRes.media,
                ...(params.caption ? { metadata: { caption: params.caption } } : {}),
              },
            ],
          },
        },
        extras(target),
      );
    },

    react: async (params) => {
      return bridge.request(
        "message.react",
        {
          "@type": TYPE_URLS.addReactionRequest,
          message_id: params.messageId,
          emoji: params.emoji,
        },
        { message_id: params.messageId },
      );
    },

    forward: async (params) => {
      const toUsername = params.toUsername?.trim().replace(/^@/, "");
      const targetConversationId = params.targetConversationId?.trim();
      if (!toUsername && !targetConversationId) {
        throw new Error(
          "forward requires exactly one of { toUsername, targetConversationId }",
        );
      }
      // `destination` is a proto `oneof`; set exactly one of the two fields.
      return bridge.request("message.forward", {
        "@type": TYPE_URLS.forwardMessageRequest,
        message_id: params.messageId,
        ...(toUsername
          ? { to_username: toUsername }
          : { conversation_id: targetConversationId }),
        comment: params.comment || "",
      });
    },

    recallSearch: async (params) => {
      return bridge.request("recall.search", {
        "@type": TYPE_URLS.recallSearchRequest,
        query: params.query,
        conversation_id: params.conversationId,
        limit: params.maxResults,
      });
    },

    recallGet: async (params) => {
      return bridge.request("recall.get", {
        "@type": TYPE_URLS.recallGetRequest,
        entry_id: params.entryId,
        conversation_id: params.conversationId,
      });
    },

    endTurn: (target) => {
      bridge.send(
        "turn.end",
        {
          "@type": TYPE_URLS.bridgeTurnEndCommand,
          status: "completed",
        },
        extras(target),
      );
    },

    emitSignal: (target, signalType, detailText = "") => {
      if (!target.conversationId) return;
      bridge.send(
        "signal.emit",
        {
          "@type": TYPE_URLS.sendSignalRequest,
          conversation_id: target.conversationId,
          signal_type: signalType,
          detail_text: detailText,
          in_reply_to: target.replyToMessageId,
        },
        extras(target),
      );
    },
  };
};
