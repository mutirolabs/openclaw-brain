// OpenClaw channel plugin definition. This file is the "hot" import path
// loaded during gateway startup and plugin discovery, so it stays narrow:
// manifest metadata plus a lazy handle into the heavier runtime module.
//
// The runtime (`channel.runtime.ts`) owns subprocess lifecycle, envelope
// dispatch, and the per-account bridge session registry.

import type {
  ChannelOutboundAdapter,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";

type ReplyToMode = "off" | "first" | "all" | "batched";

import { mutiroMessageActions } from "./actions.js";
import { mutiroAgentTools } from "./agent-tools.js";
import { mutiroConfigAdapter, type ResolvedMutiroAccount } from "./config.js";
import { mutiroSetupAdapter, mutiroSetupWizard } from "./setup-surface.js";

const loadMutiroChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "mutiroChannelRuntime",
);

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  // `sendText` is called whenever OpenClaw wants to push a text reply into a
  // Mutiro conversation. The `accountId` selects which active bridge session
  // to route through; `to` is the Mutiro `conversation_id`; `replyToId` is the
  // message the reply threads under.
  async sendText(ctx) {
    const runtime = await loadMutiroChannelRuntime();
    return runtime.sendMutiroText(ctx);
  },

  // `sendMedia` is the single-shot media path. The channel runtime uses the
  // bridge-local `media.upload` command to stage the file, then attaches it
  // to a `message.send`.
  async sendMedia(ctx) {
    const runtime = await loadMutiroChannelRuntime();
    return runtime.sendMutiroMedia(ctx);
  },
};

// Read `channels.mutiro.replyToMode` as an override; otherwise default to
// `"first"` so the agent's first reply in a turn threads under the inbound
// message. Mutiro clients render reply-to as a visible quoted pill, so this
// anchors context nicely in groups without being noisy in DMs. Set
// `channels.mutiro.replyToMode` to `"off"`, `"all"`, or `"batched"` in the
// OpenClaw config to override.
const resolveMutiroReplyToMode = ({ cfg }: { cfg: OpenClawConfig }): ReplyToMode => {
  const section = (cfg as { channels?: Record<string, unknown> }).channels?.mutiro as
    | { replyToMode?: unknown }
    | undefined;
  const configured = section?.replyToMode;
  if (configured === "off" || configured === "first" || configured === "all" || configured === "batched") {
    return configured;
  }
  return "first";
};

export const mutiroPlugin: ChannelPlugin<ResolvedMutiroAccount> = createChatChannelPlugin<
  ResolvedMutiroAccount
>({
  base: {
    id: "mutiro",
    meta: {
      id: "mutiro",
      label: "Mutiro",
      selectionLabel: "Mutiro (plugin)",
      docsPath: "/channels/mutiro",
      docsLabel: "mutiro",
      blurb: "chatbridge channel; configure a Mutiro agent directory to enable.",
      order: 80,
      quickstartAllowFrom: true,
      markdownCapable: true,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      reply: true,
      media: true,
    },
    config: mutiroConfigAdapter,
    agentTools: mutiroAgentTools,
    actions: mutiroMessageActions,

    // Setup surfaces: `setup` is the non-interactive adapter path
    // (`openclaw channels add --channel mutiro [flags]`); `setupWizard` is what
    // runs when the user invokes `openclaw channels add` with no flags and
    // picks `mutiro` from the selection list.
    setup: mutiroSetupAdapter,
    setupWizard: mutiroSetupWizard,

    // Messaging adapter: teaches OpenClaw how to recognize a Mutiro target.
    // Without it, reactions/forwards/cross-channel sends fail with
    // "Unknown target" because the core resolver can't match a
    // `conv_<uuid>` conversation id or a leading-@ username against any
    // directory/id pattern it knows about.
    messaging: {
      normalizeTarget: (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        // Strip a leading @ on usernames so downstream comparisons and the
        // bridge's `to_username` field see the raw handle.
        return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
      },
      targetResolver: {
        hint: "Use a Mutiro conversation id (e.g. conv_<uuid>) or @username.",
        looksLikeId: (raw: string, normalized?: string) => {
          const value = (normalized ?? raw).trim();
          if (!value) return false;
          // conv_<...> = conversation id; bare @handle or a plain alphanumeric
          // username both route to message.send_voice / react / etc.
          return /^conv_/i.test(value) || /^@/.test(raw) || /^[A-Za-z0-9_.-]+$/.test(value);
        },
        resolveTarget: async ({ input, normalized }) => {
          const value = (normalized || input).trim().replace(/^@/, "");
          if (!value) return null;
          const isConversation = /^conv_/i.test(value);
          return {
            to: value,
            kind: isConversation ? "group" : "user",
            display: isConversation ? value : `@${value}`,
            source: "normalized",
          };
        },
      },
    },

    // Gateway lifecycle: startAccount spawns the bridge subprocess for this
    // account and wires inbound observed messages into OpenClaw's reply
    // dispatcher. stopAccount tears the subprocess down.
    gateway: {
      async startAccount(ctx) {
        const runtime = await loadMutiroChannelRuntime();
        return runtime.startMutiroAccount(ctx);
      },
      async stopAccount(ctx) {
        const runtime = await loadMutiroChannelRuntime();
        await runtime.stopMutiroAccount(ctx);
      },
    },

    // Status adapter: answers `openclaw channels status mutiro`. The runtime
    // already updates `running` / `connected` / `lastConnectedAt` /
    // `reconnectAttempts` via `ctx.setStatus()` when the bridge subprocess
    // starts, handshakes, exits, or is in backoff. Here we just enrich the
    // snapshot with Mutiro-specific context (agent workspace path, bridge
    // mode, derived health string).
    status: {
      buildAccountSnapshot: ({ account, runtime }) => {
        const base = runtime ?? { accountId: account.accountId };
        const running = base.running ?? false;
        const connected = base.connected ?? false;
        const restartPending = base.restartPending ?? false;
        const healthState = !running
          ? restartPending
            ? "restarting"
            : "stopped"
          : connected
            ? "healthy"
            : "connecting";
        return {
          ...base,
          accountId: account.accountId,
          configured: account.configured,
          enabled: account.enabled,
          mode: "bridge",
          healthState,
          dbPath: account.config.agentDir ?? null,
        };
      },
    },
  },
  // Threading adapter: Mutiro natively supports `reply_to_message_id`, so wire
  // OpenClaw's reply-dispatch into it. `allowExplicitReplyTagsWhenOff` keeps
  // agent-directed reply markers working even when the user has disabled
  // automatic reply-threading.
  threading: {
    resolveReplyToMode: resolveMutiroReplyToMode,
    allowExplicitReplyTagsWhenOff: true,
  },
  outbound,
});
