// Message normalization helpers for inbound bridge envelopes. The host
// delivers `envelope.payload.message` as a pre-normalized bag of parts;
// these helpers turn that into plain text for the brain and into structured
// ObservedTurn records for downstream dispatch.

import type { ObservedTurn } from "./bridge-protocol.js";
import { generateId } from "./bridge-protocol.js";

const shortMessageId = (value?: string) => {
  const id = (value || "").trim();
  return id.length <= 8 ? id : id.slice(-8);
};

/**
 * Converts a normalized bridge message into plain text for the LLM.
 *
 * The host delivers messages as `envelope.payload.message` with the following shape:
 *
 *   { text?: string, parts?: ChatBridgeMessagePart[], reply_to_message_id?: string, ... }
 *
 * `parts` is an array of flat objects, each carrying a `type` string discriminator.
 * The host digests the raw wire format into this clean shape before delivery, so
 * brain implementations only need to care about the fields documented below.
 *
 * Attachment bytes for `image` and `file` parts are downloaded by the host into
 * `{agent_workspace}/Downloads/` before delivery. The local paths are conveyed
 * separately via `envelope.payload.attachment_context`; see `buildObservedTurn`.
 *
 * @see https://docs.mutiro.com/chatbridge-protocol
 */
const REACTION_QUOTE_MAX_CHARS = 160;

const truncateReactionQuote = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= REACTION_QUOTE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, REACTION_QUOTE_MAX_CHARS - 1).trimEnd()}…`;
};

/**
 * Optional context carried on the envelope that lets extractors render
 * richer text. Today: `replyToMessagePreview` comes from
 * `ChatBridgeMessageObserved.reply_to_message_preview` — a host-resolved
 * quote of the message referenced by `reply_to_message_id`. Used to turn
 * bare `[reacted 👍 to #abc12345]` placeholders into readable events the
 * model can reason about.
 */
export type BridgeMessageExtractionContext = {
  replyToMessagePreview?: string;
};

export const extractBridgeMessageText = (
  message?: {
    text?: string;
    parts?: Array<Record<string, unknown>>;
    reply_to_message_id?: string;
  },
  context?: BridgeMessageExtractionContext,
) => {
  if (!message) return "";
  const replyPreview = (context?.replyToMessagePreview ?? "").trim();

  const parts: string[] = [];
  const push = (value?: string) => {
    const trimmed = (value || "").trim();
    if (trimmed) parts.push(trimmed);
  };

  push(message.text);

  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (!part || typeof part !== "object") continue;

    const partType = (part as { type?: string }).type;
    switch (partType) {
      case "text":
        push((part as { text?: string }).text);
        break;
      case "audio":
        push((part as { transcript?: string }).transcript);
        break;
      case "card": {
        const cardId = (part as { card_id?: string }).card_id;
        push(cardId ? `[Interactive card: ${cardId}]` : "[Interactive card]");
        break;
      }
      case "card_action": {
        const p = part as { card_id?: string; action_id?: string; data_json?: string };
        push(
          `[Card interaction: card=${p.card_id || ""} action=${p.action_id || ""} data=${p.data_json || ""}]`,
        );
        break;
      }
      case "contact": {
        const meta = ((part as { metadata?: Record<string, string> }).metadata || {}) as Record<
          string,
          string
        >;
        const username = (meta.contact_username || "").trim();
        if (!username) break;
        const displayName = (meta.contact_display_name || "").trim();
        const role = (meta.contact_member_type || "").trim() === "agent" ? "agent" : "user";
        push(`[Shared contact: ${displayName || username} (@${username}, ${role})]`);
        break;
      }
      case "reaction": {
        const p = part as { reaction?: string; reaction_operation?: string };
        const emoji = (p.reaction || "").trim();
        if (!emoji) break;
        const removed = (p.reaction_operation || "").trim().toLowerCase() === "removed";
        const quote = truncateReactionQuote(replyPreview);
        if (quote) {
          push(
            removed
              ? `[reaction ${emoji} removed from message: "${quote}"]`
              : `[reaction ${emoji} received on message: "${quote}"]`,
          );
        } else {
          const target = shortMessageId(message.reply_to_message_id);
          if (removed) {
            push(
              target
                ? `[removed reaction ${emoji} from #${target}]`
                : `[removed reaction ${emoji}]`,
            );
          } else {
            push(target ? `[reacted ${emoji} to #${target}]` : `[reacted ${emoji}]`);
          }
        }
        break;
      }
      case "live_call": {
        const p = part as {
          summary_text?: string;
          action_items?: string[];
          follow_ups?: string[];
          call_id?: string;
          end_reason?: string;
        };
        const summary = (p.summary_text || "").trim();
        const actionItems = Array.isArray(p.action_items)
          ? p.action_items.map((item) => item.trim()).filter(Boolean)
          : [];
        const followUps = Array.isArray(p.follow_ups)
          ? p.follow_ups.map((item) => item.trim()).filter(Boolean)
          : [];
        // Always emit at least the header — the part existing signals the
        // call ended, even when summarization produced no text. Skipping
        // here produces an empty turn text, and downstream that becomes a
        // "no extractable content" drop. Symmetric to the host-side fix in
        // chatbridge/normalize.go.
        const lines = [
          `[Voice call summary (call_id=${(p.call_id || "").trim()}, end_reason=${(p.end_reason || "").trim()})]`,
        ];
        if (summary) lines.push(summary);
        if (actionItems.length > 0)
          lines.push(`Action items:\n${actionItems.map((item) => `- ${item}`).join("\n")}`);
        if (followUps.length > 0)
          lines.push(`Follow-ups:\n${followUps.map((item) => `- ${item}`).join("\n")}`);
        push(lines.join("\n"));
        break;
      }
      case "image": {
        const caption = (
          ((part as { metadata?: Record<string, string> }).metadata || {}).caption || ""
        ).trim();
        push(caption ? `[Image attachment: ${caption}]` : "[Image attachment]");
        break;
      }
      case "file": {
        const filename = ((part as { filename?: string }).filename || "").trim();
        const caption = (
          ((part as { metadata?: Record<string, string> }).metadata || {}).caption || ""
        ).trim();
        push(
          caption
            ? `[File attachment: ${filename || "attachment"} — ${caption}]`
            : `[File attachment: ${filename || "attachment"}]`,
        );
        break;
      }
    }
  }

  return parts.join(" ").trim();
};

export const normalizeOutputText = (value: string) => {
  const trimmed = (value || "").trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return "";
  if (lowered === "noop" || lowered === "noop.") return "";
  return trimmed;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const trimRecentMessages = <T>(messages: T[], max: number) =>
  messages.length > max ? messages.slice(-max) : messages;

export const buildSyntheticBridgeMessage = (params: {
  conversationId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
  metadata?: Record<string, string>;
}) => ({
  id: `openclaw-${generateId()}`,
  conversation_id: params.conversationId,
  reply_to_message_id: params.replyToMessageId || "",
  from: {
    username: params.senderUsername,
  },
  text: params.text,
  metadata: params.metadata || {},
});

export const cloneMessage = <T>(message: T): T => cloneJson(message);

/**
 * Assembles a promptable ObservedTurn from an inbound host envelope.
 *
 * `extractBridgeMessageText(envelope.payload.message)` converts each message
 * part (text, audio transcript, card placeholder, etc.) into inline plain text
 * for the body.
 *
 * We intentionally do NOT glue `envelope.payload.attachment_context` onto the
 * body. The host-authored description can carry stale or wrong metadata (for
 * example "0x0 pixels" when its image probe fails) and, once real bytes are
 * staged via MediaPaths, mixing it into Body confuses the model more than it
 * helps. Callers that need the raw description can read it separately via
 * `InboundMessage.attachmentContext`.
 *
 * Returns null if conversation/message ids are missing, or when both the text
 * body and any inline image attachments are empty.
 */
export const buildObservedTurn = (envelope: {
  conversation_id?: string;
  message_id?: string;
  reply_to_message_id?: string;
  payload?: {
    message?: {
      conversation_id?: string;
      id?: string;
      reply_to_message_id?: string;
      from?: { username?: string };
      text?: string;
      parts?: Array<Record<string, unknown>>;
    };
    reply_to_message_id?: string;
    attachment_context?: string;
    reply_to_message_preview?: string;
    images?: unknown[];
  };
}): ObservedTurn | null => {
  const conversationId = envelope.conversation_id || envelope.payload?.message?.conversation_id;
  const messageId = envelope.message_id || envelope.payload?.message?.id;
  const text = extractBridgeMessageText(envelope.payload?.message, {
    replyToMessagePreview: envelope.payload?.reply_to_message_preview,
  });
  const hasAttachments =
    Array.isArray(envelope.payload?.images) && (envelope.payload.images?.length ?? 0) > 0;

  if (!conversationId || !messageId || (!text && !hasAttachments)) {
    return null;
  }

  return {
    conversationId,
    messageId,
    replyToMessageId:
      envelope.reply_to_message_id ||
      envelope.payload?.reply_to_message_id ||
      envelope.payload?.message?.reply_to_message_id,
    senderUsername: envelope.payload?.message?.from?.username || "unknown",
    text,
  };
};

export const isSelfEventMessage = (
  envelope: { payload?: { message?: { from?: { username?: string } } } },
  agentUsername: string,
) => {
  const senderUsername = envelope.payload?.message?.from?.username;
  const selfUsername = (agentUsername || "").trim();
  return !senderUsername || (!!selfUsername && senderUsername === selfUsername);
};

export const applyVoiceLanguage = (voiceName: string, language: string) => {
  const trimmedVoice = voiceName.trim();
  const trimmedLanguage = language.trim();
  if (!trimmedVoice || !trimmedLanguage) {
    return trimmedVoice;
  }

  const languageParts = trimmedLanguage.split("-");
  if (languageParts.length < 2) {
    return trimmedVoice;
  }

  const voiceParts = trimmedVoice.split("-");
  if (voiceParts.length < 4) {
    return trimmedVoice;
  }

  return `${languageParts[0]}-${languageParts[1]}-${voiceParts.slice(2).join("-")}`;
};
