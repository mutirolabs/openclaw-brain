// Heavy runtime surface for the Mutiro channel plugin. Owns the registry of
// active BridgeSession instances keyed by account and serves inbound/outbound
// calls from the plugin's gateway and outbound adapters.
//
// Keeping this file separate from `channel.ts` means the light plugin entry
// does not pull the NDJSON + child_process machinery into gateway startup.

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { recordInboundSessionAndDispatchReply } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

type ChannelOutboundContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];
type OutboundDeliveryResult = Awaited<
  ReturnType<NonNullable<ChannelOutboundAdapter["sendText"]>>
>;

import { startBridgeSession, type BridgeSession } from "./bridge-session.js";
import type { ResolvedMutiroAccount } from "./config.js";
import type { InboundDeliver, InboundMessage } from "./inbound.js";
import { normalizeOutputText } from "./bridge-messages.js";

type StartContext = ChannelGatewayContext<ResolvedMutiroAccount>;

const sessions = new Map<string, BridgeSession>();

const sessionKey = (channel: string, accountId: string) => `${channel}:${accountId}`;

const requireSessionForAccount = (accountId: string | null | undefined): BridgeSession => {
  const session = sessions.get(sessionKey("mutiro", accountId ?? "default"));
  if (!session) {
    throw new Error(
      `mutiro channel: no active bridge session for account "${accountId ?? "default"}". gateway.startAccount must run first.`,
    );
  }
  return session;
};

// Public accessor used by agent tools that need to reach the active bridge
// session without throwing when the channel is not running yet.
export const getMutiroBridgeSession = (
  accountId: string | null | undefined,
): BridgeSession | undefined =>
  sessions.get(sessionKey("mutiro", accountId ?? "default"));

/**
 * Runs the agent against a delegated task prompt and returns the
 * accumulated reply text. Used by `task.request`, which — unlike
 * `message.observed` — expects the full reply text inside the
 * `ChatBridgeTaskResult` envelope instead of on the outbound bridge.
 *
 * We reuse the same reply-dispatch path as buildDeliverBridge but swap
 * the deliver callback: instead of shipping chunks via bridge.message.send
 * we accumulate them into a buffer the caller returns to the host.
 *
 * Tool side-effects (mutiro_send_voice_message, mutiro_send_card, etc.)
 * still fire normally through their own execute() paths — only the
 * agent's plain reply text is captured for the task result.
 */
const buildResolveTaskRequest = (ctx: StartContext) =>
  async (params: {
    conversationId: string;
    accountId: string;
    username?: string;
    prompt: string;
    promptData?: Record<string, string>;
    metadata?: Record<string, string>;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<string> => {
    const senderUsername = (params.username ?? "").trim() || "system";
    const route = resolveAgentRoute({
      cfg: ctx.cfg,
      channel: "mutiro",
      accountId: params.accountId,
      peer: { kind: "direct", id: senderUsername },
    });
    const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId });
    const messageSid = params.requestId ?? `task-${Date.now()}`;
    const ctxPayload = finalizeInboundContext({
      Body: params.prompt,
      BodyForAgent: params.prompt,
      RawBody: params.prompt,
      CommandBody: params.prompt,
      From: senderUsername,
      To: params.conversationId,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? params.accountId,
      ChatType: "direct",
      ConversationLabel: params.conversationId,
      SenderId: senderUsername,
      Provider: "mutiro",
      Surface: "mutiro",
      MessageSid: messageSid,
      MessageSidFull: messageSid,
      Timestamp: Date.now(),
      OriginatingChannel: "mutiro",
      OriginatingTo: params.conversationId,
    });

    const accumulator: string[] = [];
    const dispatchPromise = recordInboundSessionAndDispatchReply({
      cfg: ctx.cfg,
      channel: "mutiro",
      accountId: params.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      deliver: async (payload) => {
        const chunk = String(payload.text ?? "");
        if (chunk) accumulator.push(chunk);
      },
      onRecordError: (err) =>
        ctx.log?.warn?.(`mutiro: task record error: ${formatError(err)}`),
      onDispatchError: (err, info) =>
        ctx.log?.warn?.(`mutiro: task dispatch error (${info.kind}): ${formatError(err)}`),
    });

    // Honor timeout_ms: whichever finishes first, use what accumulated.
    // If the dispatch ran past the deadline we return partial output and
    // let the background promise drain; the host already has its answer.
    if (params.timeoutMs && params.timeoutMs > 0) {
      await Promise.race([
        dispatchPromise,
        new Promise<void>((resolve) => setTimeout(resolve, params.timeoutMs)),
      ]);
    } else {
      await dispatchPromise;
    }

    return normalizeOutputText(accumulator.join(""));
  };

const buildDeliverBridge = (ctx: StartContext): InboundDeliver =>
  async (inbound: InboundMessage) => {
    const session = requireSessionForAccount(inbound.accountId);

    // Resolve the routing / session / ctxPayload pieces directly from the
    // public plugin-sdk helpers rather than relying on `ctx.channelRuntime`
    // to carry the full runtime surface (it does not for bundled channels).
    const route = resolveAgentRoute({
      cfg: ctx.cfg,
      channel: "mutiro",
      accountId: inbound.accountId,
      peer: { kind: "direct", id: inbound.senderUsername },
    });
    const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId });

    const target = {
      conversationId: inbound.conversationId,
      replyToMessageId: inbound.messageId,
    };
    const { createSignalForwarder } = await import("./signal-forwarder.js");
    const signals = createSignalForwarder(session, target);
    // Fire a THINKING pulse immediately so the user sees feedback while
    // dispatch warms up (model selection, memory loads, etc.). Subsequent
    // on* callbacks replace it with more specific signals.
    signals.thinking();

    const mediaPaths = inbound.mediaPaths ?? [];
    const mediaTypes = inbound.mediaTypes ?? [];
    const ctxPayload = finalizeInboundContext({
      Body: inbound.text,
      BodyForAgent: inbound.text,
      RawBody: inbound.text,
      CommandBody: inbound.text,
      From: inbound.senderUsername,
      To: inbound.conversationId,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? inbound.accountId,
      ChatType: "direct",
      ConversationLabel: inbound.conversationId,
      SenderId: inbound.senderUsername,
      Provider: "mutiro",
      Surface: "mutiro",
      MessageSid: inbound.messageId,
      MessageSidFull: inbound.messageId,
      Timestamp: Date.now(),
      OriginatingChannel: "mutiro",
      OriginatingTo: inbound.conversationId,
      ...(mediaPaths.length > 0
        ? {
            MediaPath: mediaPaths[0],
            MediaPaths: mediaPaths,
            MediaType: mediaTypes[0],
            MediaTypes: mediaTypes,
          }
        : {}),
    });

    await recordInboundSessionAndDispatchReply({
      cfg: ctx.cfg,
      channel: "mutiro",
      accountId: inbound.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      deliver: async (payload) => {
        const text = normalizeOutputText(String(payload.text ?? ""));
        if (!text) return;
        await session.outbound.sendText(target, text);
      },
      // replyOptions taps OpenClaw's mid-turn hooks to forward progress
      // into Mutiro's signal stream. Each on* callback maps to a specific
      // SIGNAL_TYPE_* so the user sees "searching web", "remembering",
      // "writing response" pills instead of a single static "thinking".
      replyOptions: {
        onAssistantMessageStart: () => signals.typing(),
        onReasoningStream: () => signals.reasoning(),
        onToolStart: (payload) => signals.toolStart(payload.name, payload.phase),
        // onItemEvent carries richer detail than onToolStart — `title` is
        // resolved from tool args (e.g. "read src/x.ts"). Refine only on
        // the start phase; "end"/"update" would thrash the pill.
        onItemEvent: (payload) => {
          if (payload.phase && payload.phase !== "start") return;
          signals.itemStart({
            name: payload.name,
            title: payload.title,
            phase: payload.phase,
          });
        },
        onCompactionStart: () => signals.compactionStart(),
        onCompactionEnd: () => signals.compactionEnd(),
        onPlanUpdate: (payload) => signals.planUpdate(payload.title),
      },
      onRecordError: (err) => ctx.log?.warn?.(`mutiro: record session error: ${formatError(err)}`),
      onDispatchError: (err, info) =>
        ctx.log?.warn?.(`mutiro: dispatch error (${info.kind}): ${formatError(err)}`),
    });

    // Close the signal stream and the host-owned turn lifecycle.
    // TURN_COMPLETE clears any lingering pill in the Mutiro UI; endTurn
    // releases the host-side pending turn regardless of whether visible
    // replies were emitted.
    signals.turnComplete();
    session.outbound.endTurn(target);
  };

export const startMutiroAccount = async (ctx: StartContext) => {
  const key = sessionKey("mutiro", ctx.accountId);
  const existing = sessions.get(key);
  if (existing) {
    return;
  }

  const { account } = ctx;
  if (!account.configured || !account.config.agentDir) {
    ctx.log?.warn?.(`mutiro: account "${ctx.accountId}" is not configured (missing agentDir)`);
    return;
  }

  // The gateway expects startAccount to stay pending for the lifetime of the
  // channel. Resolving early is interpreted as "channel exited" and triggers
  // an auto-restart loop. We block on exit-or-abort via this deferred.
  let settleLifecycle: () => void = () => {};
  const lifecycle = new Promise<void>((resolve) => {
    settleLifecycle = resolve;
  });

  const session = await startBridgeSession({
    accountId: ctx.accountId,
    agentDir: account.config.agentDir,
    clientName: account.config.clientName,
    requestedOptionalCapabilities: account.config.requestedOptionalCapabilities,
    deliver: buildDeliverBridge(ctx),
    resolveTaskRequest: buildResolveTaskRequest(ctx),
    resolveLiveSnapshot: async (params) => {
      // Lazy-load the snapshot module so startup stays clean and the
      // plugin-sdk/config-runtime surface is only touched when the host
      // actually requests a live handoff (i.e. a voice call starts).
      const { buildLiveSnapshot } = await import("./live-snapshot.js");
      return buildLiveSnapshot({
        cfg: ctx.cfg,
        accountId: params.accountId,
        conversationId: params.conversationId,
        callerUsername: params.username,
        callId: params.callId,
        agentUsername: session?.getAgentUsername() ?? "",
      });
    },
    logger: ctx.log
      ? {
          info: ctx.log.info,
          warn: ctx.log.warn,
          error: ctx.log.error,
        }
      : undefined,
    onHostExit: (code) => {
      sessions.delete(key);
      ctx.log?.info?.(`mutiro: host (${ctx.accountId}) exited with code ${code}`);
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        connected: false,
        lastDisconnect: { at: Date.now(), status: code ?? undefined },
      });
      settleLifecycle();
    },
  });

  sessions.set(key, session);
  ctx.setStatus({
    ...ctx.getStatus(),
    running: true,
    connected: true,
    lastConnectedAt: Date.now(),
    lastStartAt: Date.now(),
  });

  const onAbort = () => {
    void stopSession(key).finally(settleLifecycle);
  };
  if (ctx.abortSignal.aborted) {
    onAbort();
  } else {
    ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  await lifecycle;
};

export const stopMutiroAccount = async (ctx: StartContext) => {
  await stopSession(sessionKey("mutiro", ctx.accountId));
  ctx.setStatus({
    ...ctx.getStatus(),
    running: false,
    connected: false,
    lastStopAt: Date.now(),
  });
};

const stopSession = async (key: string) => {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  await session.shutdown();
};

export const sendMutiroText = async (
  ctx: ChannelOutboundContext,
): Promise<OutboundDeliveryResult> => {
  const session = requireSessionForAccount(ctx.accountId);
  await session.outbound.sendText(
    {
      conversationId: ctx.to,
      replyToMessageId: ctx.replyToId ?? ctx.threadId?.toString() ?? "",
    },
    ctx.text,
  );
  return {
    channel: "mutiro",
    messageId: ctx.replyToId ?? `mutiro-${Date.now()}`,
    conversationId: ctx.to,
  };
};

export const sendMutiroMedia = async (
  ctx: ChannelOutboundContext,
): Promise<OutboundDeliveryResult> => {
  if (!ctx.mediaUrl) {
    throw new Error("sendMedia called without mediaUrl");
  }
  const session = requireSessionForAccount(ctx.accountId);
  await session.outbound.sendFile(
    {
      conversationId: ctx.to,
      replyToMessageId: ctx.replyToId ?? ctx.threadId?.toString() ?? "",
    },
    {
      filePath: ctx.mediaUrl,
      caption: ctx.text,
    },
  );
  return {
    channel: "mutiro",
    messageId: ctx.replyToId ?? `mutiro-${Date.now()}`,
    conversationId: ctx.to,
  };
};

const formatError = (err: unknown) =>
  err instanceof Error ? err.message : JSON.stringify(err);

// Dispatcher for ChannelMessageActionAdapter.handleAction. Declared here so
// the heavy runtime does the bridge work, and the light `actions.ts` file
// stays a pure control-plane adapter that loads this lazily.
export const handleMutiroMessageAction = async (params: {
  action: string;
  params: Record<string, unknown>;
  accountId?: string;
  readStringArg: (params: Record<string, unknown>, ...keys: string[]) => string | undefined;
}) => {
  const session = requireSessionForAccount(params.accountId);

  if (params.action === "react") {
    const messageId = params.readStringArg(params.params, "messageId", "message_id", "to");
    const emoji = params.readStringArg(params.params, "emoji", "reaction");
    if (!messageId) {
      return {
        content: [{ type: "text" as const, text: "react requires a messageId." }],
        details: { ok: false, reason: "missing_message_id" },
      };
    }
    if (!emoji) {
      return {
        content: [{ type: "text" as const, text: "react requires an emoji." }],
        details: { ok: false, reason: "missing_emoji" },
      };
    }
    try {
      const raw = await session.outbound.react({ messageId, emoji });
      return {
        content: [{ type: "text" as const, text: `Reacted ${emoji} to ${messageId}.` }],
        details: { ok: true, raw },
      };
    } catch (err) {
      const message = formatError(err);
      return {
        content: [{ type: "text" as const, text: `Failed to react: ${message}` }],
        details: { ok: false, reason: "bridge_error", error: message },
      };
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Unsupported Mutiro message action: ${params.action}`,
      },
    ],
    details: { ok: false, reason: "unsupported_action", action: params.action },
  };
};

// Barrel export consumed by the plugin entry via `loadBundledEntryExportSync`.
export const mutiroChannelRuntime = {
  startMutiroAccount,
  stopMutiroAccount,
  sendMutiroText,
  sendMutiroMedia,
};
