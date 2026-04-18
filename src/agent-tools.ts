// Channel-owned agent tools. Exposed to OpenClaw's agent loop via
// `ChannelPlugin.agentTools`. The first one mirrors pi-brain's
// `send_voice_message`: a text-to-speech voice message delivered through the
// bridge's `message.send_voice` command (host-side TTS, not client-side).

import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";

import { DEFAULT_ACCOUNT_ID } from "./config.js";

// Host errors arrive as structured { code, message } objects. Our catch
// blocks previously called String(err), which rendered them as
// "[object Object]" and hid the real reason for a rejected bridge request.
const formatBridgeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const record = err as { code?: string; message?: string };
    const parts: string[] = [];
    if (record.code) parts.push(record.code);
    if (record.message) parts.push(record.message);
    if (parts.length > 0) return parts.join(": ");
    try {
      return JSON.stringify(err);
    } catch {
      // fall through
    }
  }
  return String(err);
};

type VoiceToolArgs = {
  to_username?: string;
  speech?: string;
  language?: string;
  conversation_id?: string;
  reply_to_message_id?: string;
  account_id?: string;
};

const createSendVoiceMessageTool = (): ChannelAgentTool => ({
  name: "mutiro_send_voice_message",
  label: "Send Mutiro Voice Message",
  description:
    "Send a text-to-speech voice message to a Mutiro user. The host synthesizes the audio; this does not upload a file. Use when the user asked for an audio reply or when voice is the right modality.",
  parameters: Type.Object({
    to_username: Type.String({
      description: "Target Mutiro username. Leading '@' is optional.",
    }),
    speech: Type.String({
      description: "Plain text to synthesize into speech. Keep it short and speakable.",
    }),
    language: Type.Optional(
      Type.String({
        description: "Optional BCP-47 language code (e.g. en-US, pt-BR). Retargets the default voice.",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description: "Conversation id to thread the voice message under. Defaults to direct DM.",
      }),
    ),
    reply_to_message_id: Type.Optional(
      Type.String({
        description: "Optional id of the message being replied to.",
      }),
    ),
    account_id: Type.Optional(
      Type.String({
        description:
          "Mutiro account id to send from. Omit for the default account when only one is configured.",
      }),
    ),
  }),
  execute: async (_toolCallId, rawArgs) => {
    const args = (rawArgs ?? {}) as VoiceToolArgs;
    const toUsername = (args.to_username ?? "").trim();
    const speech = (args.speech ?? "").trim();
    if (!toUsername) {
      return {
        content: [{ type: "text", text: "to_username is required." }],
        details: { ok: false, reason: "missing_to_username" },
      };
    }
    if (!speech) {
      return {
        content: [{ type: "text", text: "speech is required." }],
        details: { ok: false, reason: "missing_speech" },
      };
    }

    const accountId = (args.account_id ?? "").trim() || DEFAULT_ACCOUNT_ID;
    // Dynamic import keeps the heavy channel runtime off the hot import path
    // (the agentTools factory runs during plugin registration; execute only
    // runs when the agent actually calls the tool).
    const { getMutiroBridgeSession } = await import("./channel.runtime.js");
    const session = getMutiroBridgeSession(accountId);
    if (!session) {
      return {
        content: [
          {
            type: "text",
            text: `Mutiro bridge session for account "${accountId}" is not running.`,
          },
        ],
        details: { ok: false, reason: "no_active_session", accountId },
      };
    }

    try {
      const result = await session.outbound.sendVoice(
        {
          conversationId: args.conversation_id ?? "",
          replyToMessageId: args.reply_to_message_id ?? "",
        },
        {
          toUsername,
          speech,
          ...(args.language ? { language: args.language } : {}),
        },
      );
      return {
        content: [{ type: "text", text: "Voice message sent." }],
        details: { ok: true, raw: result },
      };
    } catch (err) {
      const message = formatBridgeError(err);
      return {
        content: [{ type: "text", text: `Failed to send voice message: ${message}` }],
        details: { ok: false, reason: "bridge_error", error: message },
      };
    }
  },
});

type CardToolArgs = {
  jsonl?: string;
  conversation_id?: string;
  reply_to_message_id?: string;
  card_id?: string;
  version?: string;
  account_id?: string;
};

// Valid A2UI v0.8 payloads. Shapes taken directly from
// @a2ui/web_core/src/v0_8/schemas/server_to_client_with_standard_catalog.json
// — the schema the Mutiro client renderer actually validates against:
//  - components[].component is a SINGULAR wrapper with ONE key (the type)
//  - Column.children is { explicitList: [id, id, ...] } (not a bare array)
//  - Button references a child Text component by id in its `child` field;
//    it does NOT have a `label` property
//  - Text content is text.literalString (or text.path for data bindings)
//  - Image.url follows the SAME shape as Text.text — an object with EITHER
//    literalString OR path, never a bare string
//  - dataModelUpdate.contents is an ARRAY of { key, valueString|valueNumber|
//    valueBoolean|valueMap }, not a flat object

const CARD_EXAMPLE_BUTTON = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [
        {
          id: "root",
          component: { Column: { children: { explicitList: ["btn"] } } },
        },
        {
          id: "btn",
          component: {
            Button: { child: "btn_label", action: { name: "say_hello" }, primary: true },
          },
        },
        {
          id: "btn_label",
          component: { Text: { text: { literalString: "olá" } } },
        },
      ],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");

const CARD_EXAMPLE_IMAGE_LITERAL = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [
        {
          id: "root",
          component: { Column: { children: { explicitList: ["title", "pic"] } } },
        },
        {
          id: "title",
          component: { Text: { text: { literalString: "Google" } } },
        },
        {
          id: "pic",
          component: {
            Image: {
              url: {
                literalString:
                  "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png",
              },
              fit: "contain",
              usageHint: "mediumFeature",
            },
          },
        },
      ],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");

// Same card as above but using a data-model path binding for the URL, to show
// the correct dataModelUpdate.contents array-of-typed-entries shape. Prefer
// literalString for fixed content; use path bindings only when the data will
// change (forms, templated lists).
const CARD_EXAMPLE_IMAGE_BINDING = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [
        {
          id: "root",
          component: { Column: { children: { explicitList: ["pic"] } } },
        },
        {
          id: "pic",
          component: {
            Image: {
              url: { path: "/poster" },
              fit: "contain",
              usageHint: "mediumFeature",
            },
          },
        },
      ],
    },
  }),
  JSON.stringify({
    dataModelUpdate: {
      surfaceId: "main",
      contents: [
        {
          key: "poster",
          valueString:
            "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png",
        },
      ],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");

// Property names whose values must be the A2UI { literalString | path }
// envelope rather than a bare string. Common renderer-silent failure: the
// model writes `url: "https://..."` directly and the renderer just shows
// nothing because `url.literalString` / `url.path` are both undefined.
const LITERAL_OR_PATH_PROPERTIES_BY_COMPONENT_TYPE: Record<string, string[]> = {
  Text: ["text"],
  Heading: ["text"],
  Image: ["url"],
  Icon: ["name"],
};

const looksLikeBareString = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

const isLiteralOrPathEnvelope = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const envelope = value as { literalString?: unknown; path?: unknown };
  return typeof envelope.literalString === "string" || typeof envelope.path === "string";
};

const validateComponentShape = (
  rawComp: unknown,
  lineNumber: number,
  componentIndex: number,
): string | null => {
  if (!rawComp || typeof rawComp !== "object") {
    return `line ${lineNumber}: component at index ${componentIndex} is not an object`;
  }
  const comp = rawComp as {
    id?: unknown;
    component?: unknown;
    componentProperties?: unknown;
  };
  if (typeof comp.id !== "string" || !comp.id) {
    return `line ${lineNumber}: component at index ${componentIndex} is missing a string "id"`;
  }
  if (comp.componentProperties !== undefined && comp.component === undefined) {
    return `line ${lineNumber}: component "${comp.id}" uses "componentProperties" — the correct A2UI v0.8 field name is "component" (singular)`;
  }
  if (!comp.component || typeof comp.component !== "object") {
    return `line ${lineNumber}: component "${comp.id}" is missing a "component" wrapper object`;
  }
  const typeKeys = Object.keys(comp.component as Record<string, unknown>);
  if (typeKeys.length !== 1) {
    return `line ${lineNumber}: component "${comp.id}".component must contain exactly one key (the type name, e.g. Text/Button/Image); got ${typeKeys.length} keys (${typeKeys.join(", ")})`;
  }
  const typeName = typeKeys[0];
  const typeProps = (comp.component as Record<string, unknown>)[typeName];
  const requiredLiteralOrPathProps = LITERAL_OR_PATH_PROPERTIES_BY_COMPONENT_TYPE[typeName];
  if (requiredLiteralOrPathProps && typeProps && typeof typeProps === "object") {
    const propsRecord = typeProps as Record<string, unknown>;
    for (const propName of requiredLiteralOrPathProps) {
      const value = propsRecord[propName];
      if (value === undefined) continue;
      if (looksLikeBareString(value)) {
        return `line ${lineNumber}: component "${comp.id}" (${typeName}).${propName} is a bare string — must be an object with either "literalString" or "path"`;
      }
      if (!isLiteralOrPathEnvelope(value)) {
        return `line ${lineNumber}: component "${comp.id}" (${typeName}).${propName} must be an object with either "literalString" or "path"`;
      }
    }
  }
  return null;
};

const validateCardJsonl = (jsonl: string): string | null => {
  // Minimal structural guard so we reject obvious model mistakes with a clear
  // error instead of letting the Mutiro client throw "undefined is not an
  // object (evaluating 'message.components')" at the renderer.
  let sawSurfaceUpdateWithComponents = false;
  let sawBeginRendering = false;
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, raw] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return `line ${index + 1} is not valid JSON`;
    }
    if (!parsed || typeof parsed !== "object") {
      return `line ${index + 1} is not a JSON object`;
    }
    const env = parsed as Record<string, unknown>;
    if (env.surfaceUpdate) {
      const update = env.surfaceUpdate as { components?: unknown };
      if (!Array.isArray(update.components)) {
        return `line ${index + 1}: surfaceUpdate is missing a "components" array`;
      }
      for (const [compIdx, rawComp] of (update.components as unknown[]).entries()) {
        const compError = validateComponentShape(rawComp, index + 1, compIdx);
        if (compError) return compError;
      }
      sawSurfaceUpdateWithComponents = true;
    }
    if (env.dataModelUpdate) {
      const update = env.dataModelUpdate as { contents?: unknown };
      if (update.contents !== undefined && !Array.isArray(update.contents)) {
        return `line ${index + 1}: dataModelUpdate.contents must be an array of { key, valueString|valueNumber|valueBoolean|valueMap } entries (got an object — likely a map instead of a typed-entry array)`;
      }
    }
    if (env.beginRendering) {
      const begin = env.beginRendering as { root?: unknown };
      if (typeof begin.root !== "string" || !begin.root) {
        return `line ${index + 1}: beginRendering is missing a "root" component id`;
      }
      sawBeginRendering = true;
    }
  }
  if (!sawSurfaceUpdateWithComponents) {
    return "jsonl must include at least one surfaceUpdate line with a components array";
  }
  if (!sawBeginRendering) {
    return "jsonl must include a final beginRendering line referencing a root component id";
  }
  return null;
};

const createSendCardTool = (): ChannelAgentTool => ({
  name: "mutiro_send_card",
  label: "Send Mutiro Card",
  description: [
    "Send an interactive A2UI v0.8 card into a Mutiro conversation. The `jsonl` argument is one JSON object per line (same format as the `canvas` tool's `a2ui_push` action).",
    "Envelope types: `surfaceUpdate`, optional `dataModelUpdate`, then `beginRendering`.",
    "",
    "Component shape (critical — wrong shape renders a blank card with no error):",
    "- Each component has an `id` and a `component` object (SINGULAR; not `componentProperties`).",
    "- `component` has EXACTLY one key: the type name (`Column`, `Row`, `Text`, `Button`, `Heading`, `Image`, `TextField`, `CheckBox`, etc.).",
    "- `Column`/`Row` children go in `children.explicitList: [id, id]` (NOT a bare array).",
    "- `Button` references a child Text component by id via the `child` field. It does NOT accept a `label` string directly.",
    "- `Text` content is `text.literalString: '...'` (or `text.path: '/some/binding'` for data-model bindings).",
    "- `Image` url uses the SAME shape as Text.text — `url.literalString: 'https://...'` OR `url.path: '/some/key'`. NEVER `url: 'https://...'` as a bare string.",
    "- `Icon` name uses the same literalString/path shape.",
    "- Every id referenced anywhere (children, Button.child, beginRendering.root) MUST exist as a component in the same `components` array.",
    "",
    "Literal vs path — prefer literal for fixed content, use path only for bindings:",
    "- For a static image, a fixed heading, a one-off button — use `{ literalString: '...' }`. No dataModelUpdate needed.",
    "- For templated lists, form inputs that bind back to the agent, or content that should update without rebuilding the surface — use `{ path: '/some/key' }` and ship a `dataModelUpdate` with matching entries.",
    "",
    "`dataModelUpdate.contents` is an ARRAY of typed entries, NOT a flat object. Each entry is `{ key, valueString }` (or `valueNumber`, `valueBoolean`, `valueMap`). Writing `contents: { poster: '...' }` leaves the model empty and every `path`-bound property resolves to undefined.",
    "",
    "Working example 1 — button with text (simplest interactive):",
    CARD_EXAMPLE_BUTTON,
    "",
    "Working example 2 — image with literal URL (preferred for fixed images):",
    CARD_EXAMPLE_IMAGE_LITERAL,
    "",
    "Working example 3 — image URL via data-model binding (only when binding is needed). Note the `contents` ARRAY shape:",
    CARD_EXAMPLE_IMAGE_BINDING,
    "",
    "Minimum structural rules enforced by this tool:",
    "- At least one `surfaceUpdate` line with a non-empty `components` array.",
    "- Exactly one final `beginRendering` line with a `root` id that exists in the surface.",
    "",
    "If a card is needed, prefer a simple Column-of-Text for text-only output and only add interactive components (Button, TextField, CheckBox) when the user would actually interact with them.",
  ].join("\n"),
  parameters: Type.Object({
    jsonl: Type.String({
      description:
        "A2UI JSONL payload. One JSON object per line. Typically: a `surfaceUpdate` with components, an optional `dataModelUpdate` for bindings, and a final `beginRendering` to commit.",
    }),
    conversation_id: Type.Optional(
      Type.String({
        description:
          "Conversation id to deliver the card to. Defaults to the conversation the agent is currently replying in.",
      }),
    ),
    reply_to_message_id: Type.Optional(
      Type.String({
        description: "Optional id of the message the card replies to.",
      }),
    ),
    card_id: Type.Optional(
      Type.String({
        description: "Optional stable id. One is generated automatically if omitted.",
      }),
    ),
    version: Type.Optional(
      Type.String({
        description: "A2UI protocol version. Defaults to 0.8.",
      }),
    ),
    account_id: Type.Optional(
      Type.String({
        description:
          "Mutiro account id to send from. Omit for the default account when only one is configured.",
      }),
    ),
  }),
  execute: async (_toolCallId, rawArgs) => {
    const args = (rawArgs ?? {}) as CardToolArgs;
    const jsonl = (args.jsonl ?? "").trim();
    if (!jsonl) {
      return {
        content: [{ type: "text", text: "jsonl is required." }],
        details: { ok: false, reason: "missing_jsonl" },
      };
    }

    const validationError = validateCardJsonl(jsonl);
    if (validationError) {
      return {
        content: [
          {
            type: "text",
            text: `Card jsonl is malformed: ${validationError}. Please retry using the example in the tool description.`,
          },
        ],
        details: { ok: false, reason: "invalid_jsonl", error: validationError },
      };
    }

    const accountId = (args.account_id ?? "").trim() || DEFAULT_ACCOUNT_ID;
    const { getMutiroBridgeSession } = await import("./channel.runtime.js");
    const session = getMutiroBridgeSession(accountId);
    if (!session) {
      return {
        content: [
          {
            type: "text",
            text: `Mutiro bridge session for account "${accountId}" is not running.`,
          },
        ],
        details: { ok: false, reason: "no_active_session", accountId },
      };
    }

    try {
      const result = await session.outbound.sendCardJsonl(
        {
          conversationId: args.conversation_id ?? "",
          replyToMessageId: args.reply_to_message_id ?? "",
        },
        {
          jsonl,
          ...(args.version ? { version: args.version } : {}),
          ...(args.card_id ? { cardId: args.card_id } : {}),
        },
      );
      return {
        content: [{ type: "text", text: "Card sent." }],
        details: { ok: true, raw: result },
      };
    } catch (err) {
      const message = formatBridgeError(err);
      return {
        content: [{ type: "text", text: `Failed to send card: ${message}` }],
        details: { ok: false, reason: "bridge_error", error: message },
      };
    }
  },
});

type ForwardToolArgs = {
  message_id?: string;
  // Provide EXACTLY one of these destinations. The bridge's
  // ForwardMessageRequest.destination is a proto `oneof`:
  //   - `to_username` — forward to a user (host creates/reuses a direct conversation)
  //   - `conversation_id` — forward to an existing conversation
  to_username?: string;
  target_conversation_id?: string;
  comment?: string;
  account_id?: string;
};

const createForwardMessageTool = (): ChannelAgentTool => ({
  name: "mutiro_forward_message",
  label: "Forward Mutiro Message",
  description: [
    "Forward an existing Mutiro message to either a user or an existing conversation.",
    "Use this when the user asks to share, resend, or forward a specific message they (or the agent) received earlier — not to paraphrase it.",
    "",
    "Required: `message_id` (id of the message being forwarded).",
    "Destination — provide EXACTLY ONE of:",
    "- `to_username`: forward to a user by handle (with or without leading '@'). The host creates or reuses a direct conversation. Use this when the user names a recipient by username.",
    "- `target_conversation_id`: forward to an existing conversation (conv_<uuid>). Use this when the user names a specific conversation id.",
    "Optional: `comment` — a note to include with the forwarded message.",
  ].join("\n"),
  parameters: Type.Object({
    message_id: Type.String({
      description: "ID of the message to forward.",
    }),
    to_username: Type.Optional(
      Type.String({
        description:
          "Destination username (with or without leading '@'). Provide this OR target_conversation_id, not both.",
      }),
    ),
    target_conversation_id: Type.Optional(
      Type.String({
        description:
          "Destination conversation id (conv_<uuid>). Provide this OR to_username, not both.",
      }),
    ),
    comment: Type.Optional(
      Type.String({
        description: "Optional note to include with the forwarded message.",
      }),
    ),
    account_id: Type.Optional(
      Type.String({
        description:
          "Mutiro account id to send from. Omit for the default account when only one is configured.",
      }),
    ),
  }),
  execute: async (_toolCallId, rawArgs) => {
    const args = (rawArgs ?? {}) as ForwardToolArgs;
    const messageId = (args.message_id ?? "").trim();
    const toUsername = (args.to_username ?? "").trim().replace(/^@/, "");
    const targetConversationId = (args.target_conversation_id ?? "").trim();

    if (!messageId) {
      return {
        content: [{ type: "text", text: "message_id is required." }],
        details: { ok: false, reason: "missing_message_id" },
      };
    }
    if (!toUsername && !targetConversationId) {
      return {
        content: [
          {
            type: "text",
            text: "Provide either to_username or target_conversation_id as the destination.",
          },
        ],
        details: { ok: false, reason: "missing_destination" },
      };
    }
    if (toUsername && targetConversationId) {
      return {
        content: [
          {
            type: "text",
            text: "Provide exactly one destination: to_username OR target_conversation_id, not both.",
          },
        ],
        details: { ok: false, reason: "conflicting_destination" },
      };
    }

    const accountId = (args.account_id ?? "").trim() || DEFAULT_ACCOUNT_ID;
    const { getMutiroBridgeSession } = await import("./channel.runtime.js");
    const session = getMutiroBridgeSession(accountId);
    if (!session) {
      return {
        content: [
          {
            type: "text",
            text: `Mutiro bridge session for account "${accountId}" is not running.`,
          },
        ],
        details: { ok: false, reason: "no_active_session", accountId },
      };
    }

    try {
      const result = await session.outbound.forward({
        messageId,
        ...(toUsername ? { toUsername } : { targetConversationId }),
        ...(args.comment ? { comment: args.comment } : {}),
      });
      const destination = toUsername ? `@${toUsername}` : targetConversationId;
      return {
        content: [
          {
            type: "text",
            text: `Forwarded ${messageId} to ${destination}.`,
          },
        ],
        details: { ok: true, raw: result },
      };
    } catch (err) {
      const message = formatBridgeError(err);
      return {
        content: [{ type: "text", text: `Failed to forward message: ${message}` }],
        details: { ok: false, reason: "bridge_error", error: message },
      };
    }
  },
});

export const mutiroAgentTools = (): ChannelAgentTool[] => [
  createSendVoiceMessageTool(),
  createSendCardTool(),
  createForwardMessageTool(),
];
