// Translates bridge observed messages into the inbound delivery the OpenClaw
// gateway expects from a channel plugin. The runtime installs a single inbound
// delivery callback during plugin startup; this module's job is to shape each
// observed bridge envelope into that callback's input.

import { saveMediaBuffer } from "openclaw/plugin-sdk/browser-setup-tools";

import type { ObservedTurn } from "./bridge-protocol.js";
import { buildObservedTurn, isSelfEventMessage } from "./bridge-messages.js";

export type InboundMessage = {
  channelId: "mutiro";
  accountId: string;
  conversationId: string;
  messageId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
  rawMessage: unknown;
  attachmentContext?: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
};

export type InboundDeliver = (message: InboundMessage) => Promise<void> | void;

export type InboundRoute = {
  accountId: string;
  agentUsername: string;
  deliver: InboundDeliver;
};

type BridgeImage = {
  data?: string;
  mime_type?: string;
  filename?: string;
};

/**
 * The bridge delivers image attachments inline as base64 under
 * `envelope.payload.images`. We persist each one into OpenClaw's media
 * directory via `saveMediaBuffer`, which stages under `~/.openclaw/media/`
 * — the only root OpenClaw's sandbox staging policy accepts. Writing to
 * `os.tmpdir()` silently fails staging and leaves the agent with only a
 * text path reference, so the bytes never reach the model.
 */
const persistInlineImages = async (
  images: BridgeImage[] | undefined,
): Promise<{ paths: string[]; types: string[] }> => {
  if (!Array.isArray(images) || images.length === 0) {
    return { paths: [], types: [] };
  }

  const paths: string[] = [];
  const types: string[] = [];
  for (const entry of images) {
    if (!entry?.data) continue;
    try {
      const saved = await saveMediaBuffer(
        Buffer.from(entry.data, "base64"),
        entry.mime_type,
        "inbound",
        undefined,
        entry.filename,
      );
      paths.push(saved.path);
      types.push(saved.contentType ?? entry.mime_type ?? "application/octet-stream");
    } catch {
      // Best-effort: skip a single bad attachment rather than aborting the turn.
    }
  }
  return { paths, types };
};

/**
 * Shapes a bridge envelope into the OpenClaw inbound message the gateway
 * delivers to core. Returns the observed turn it extracted (useful for the
 * caller to key session state) or null when the envelope was self-authored or
 * did not carry a deliverable message.
 */
export const deliverObservedEnvelope = async (
  envelope: {
    type?: string;
    payload?: {
      message?: unknown;
      attachment_context?: string;
      images?: BridgeImage[];
    };
  } & Parameters<typeof buildObservedTurn>[0],
  route: InboundRoute,
): Promise<ObservedTurn | null> => {
  if (envelope.type === "event.message" && isSelfEventMessage(envelope, route.agentUsername)) {
    return null;
  }

  // Reactions and other bare events are now delivered to OpenClaw like any
  // other observation. The agent may choose to stay silent, which today
  // surfaces "Agent couldn't generate a response" — acceptable trade-off
  // for letting the agent actually see reactions happen. If OpenClaw grows
  // a "silent turn is ok" dispatch option later, filter these through that.
  const turn = buildObservedTurn(envelope);
  if (!turn) {
    return null;
  }

  const { paths, types } = await persistInlineImages(envelope.payload?.images);

  // attachment_context is the host's narrative of downloaded attachments:
  //   [SYSTEM: Downloaded 1 file(s) to your workspace:
  //    • nf-2976.pdf → /Users/.../Downloads/nf-2976.pdf (PDF, 450 KB)]
  // For PDFs/docs this is the ONLY pointer the agent gets — it needs the
  // path to invoke `read` or a doc-extraction tool. We earlier stripped
  // this string because the host's image probe produced noisy "0x0 pixels"
  // metadata that fooled vision models. Image turns now route bytes
  // through MediaPaths instead, so attachment_context is pure signal for
  // non-image attachments. Append only when the message carries file-type
  // parts; skip for image-only or text-only turns.
  const hasFileParts = extractHasFileParts(
    envelope.payload?.message as { parts?: Array<{ type?: string }> } | undefined,
  );
  const contextText = (envelope.payload?.attachment_context ?? "").trim();
  const bodyText =
    hasFileParts && contextText
      ? turn.text
        ? `${turn.text}\n\n${contextText}`
        : contextText
      : turn.text;

  await route.deliver({
    channelId: "mutiro",
    accountId: route.accountId,
    conversationId: turn.conversationId,
    messageId: turn.messageId,
    replyToMessageId: turn.replyToMessageId,
    senderUsername: turn.senderUsername,
    text: bodyText,
    rawMessage: envelope.payload?.message,
    attachmentContext: envelope.payload?.attachment_context,
    ...(paths.length > 0 ? { mediaPaths: paths, mediaTypes: types } : {}),
  });

  return turn;
};

const extractHasFileParts = (
  message: { parts?: Array<{ type?: string }> } | undefined,
): boolean => {
  if (!message) return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some((part) => part?.type === "file");
};
