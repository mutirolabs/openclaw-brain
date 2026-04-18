// Builds the live-handoff snapshot the host requests when a voice call
// starts. This is the brain's chance to hand OpenClaw's agent persona,
// the real session transcript, and channel-owned tool hints to Mutiro's
// live voice model so the call doesn't start with a generic LLM.
//
// The three fields returned map 1:1 to ChatBridgeSessionSnapshotResult:
//   system_instruction   ← agent's systemPromptOverride (or a minimal header)
//   recent_messages      ← recent turns parsed from OpenClaw's session jsonl
//   tool_hints           ← channel-owned agent tools advertised by the plugin

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

import type { LiveSnapshot, LiveToolHint } from "./bridge-session.js";

const MAX_RECENT_TRANSCRIPT_TURNS = 30;

type AgentConfigLike = {
  name?: string;
  systemPromptOverride?: string;
};

type SessionEntryLike = {
  sessionId?: string;
  sessionFile?: string;
};

type SessionStoreRecord = Record<string, SessionEntryLike>;

const resolveAgentConfig = (
  cfg: OpenClawConfig,
  agentId: string,
): AgentConfigLike | undefined => {
  const agents = (cfg as { agents?: { agents?: Record<string, AgentConfigLike> } }).agents;
  return agents?.agents?.[agentId];
};

const buildSystemInstruction = (params: {
  agentId: string;
  agentConfig: AgentConfigLike | undefined;
  agentUsername: string;
  callerUsername?: string;
}): string => {
  const override = params.agentConfig?.systemPromptOverride?.trim();
  if (override) {
    return override;
  }
  const displayName = params.agentConfig?.name?.trim() || params.agentId;
  const callerSuffix = params.callerUsername ? ` Caller: @${params.callerUsername}.` : "";
  return [
    `You are ${displayName}, the same agent this user speaks with in chat.`,
    "You are now speaking live over voice.",
    "Stay concise, conversational, and in the agent's established persona.",
    `Agent identity: @${params.agentUsername}.${callerSuffix}`,
  ].join(" ");
};

type JsonlLine = {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
  };
};

type JsonlContent = NonNullable<NonNullable<JsonlLine["message"]>["content"]>;

const extractTextFromContent = (content: JsonlContent | undefined): string => {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("").trim();
};

const readRecentTranscriptTurns = async (
  sessionFile: string,
  conversationId: string,
  agentUsername: string,
): Promise<unknown[]> => {
  const raw = await fs.readFile(sessionFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const turns: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(trimmed) as JsonlLine;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const role = parsed.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextFromContent(parsed.message?.content);
    if (!text) continue;
    const fromUsername = role === "assistant" ? agentUsername : "user";
    turns.push({
      id: `transcript-${turns.length}`,
      conversation_id: conversationId,
      from: { username: fromUsername },
      text,
    });
  }
  return turns.slice(-MAX_RECENT_TRANSCRIPT_TURNS);
};

const readRecentMessagesFromStore = async (params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  agentUsername: string;
}): Promise<unknown[] | undefined> => {
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const { loadSessionStore } = await import("openclaw/plugin-sdk/config-runtime");
    const store = loadSessionStore(storePath) as SessionStoreRecord;
    const entry = store[params.sessionKey];
    if (!entry?.sessionId) return undefined;
    const sessionFile =
      entry.sessionFile && entry.sessionFile.trim()
        ? entry.sessionFile
        : path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
    return await readRecentTranscriptTurns(sessionFile, params.conversationId, params.agentUsername);
  } catch {
    return undefined;
  }
};

const buildToolHints = async (): Promise<LiveToolHint[]> => {
  // Lazy import so the light startup path stays clean.
  const { mutiroAgentTools } = await import("./agent-tools.js");
  return mutiroAgentTools().map((tool) => {
    const rawDescription = tool.description;
    const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
    return {
      name: tool.name,
      description,
      metadata: {},
    };
  });
};

export type LiveSnapshotContext = {
  cfg: OpenClawConfig;
  accountId: string;
  conversationId: string;
  callerUsername?: string;
  callId?: string;
  agentUsername: string;
};

/**
 * Assemble everything the live voice model needs to speak as OpenClaw's
 * agent. Safe to call even when config/session state is incomplete: each
 * section degrades independently (missing agent config → minimal header,
 * missing transcript → undefined recent_messages, tool enumeration always
 * succeeds).
 */
export const buildLiveSnapshot = async (
  ctx: LiveSnapshotContext,
): Promise<LiveSnapshot> => {
  const route = resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "mutiro",
    accountId: ctx.accountId,
    peer: { kind: "direct", id: ctx.callerUsername ?? "unknown" },
  });
  const agentConfig = resolveAgentConfig(ctx.cfg, route.agentId);

  const systemInstruction = buildSystemInstruction({
    agentId: route.agentId,
    agentConfig,
    agentUsername: ctx.agentUsername,
    callerUsername: ctx.callerUsername,
  });

  const recentMessages = await readRecentMessagesFromStore({
    cfg: ctx.cfg,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    conversationId: ctx.conversationId,
    agentUsername: ctx.agentUsername,
  });

  const toolHints = await buildToolHints();

  const metadata: Record<string, string> = {
    agent_id: route.agentId,
    session_key: route.sessionKey,
  };
  if (ctx.callId) metadata.call_id = ctx.callId;

  return {
    systemInstruction,
    ...(recentMessages ? { recentMessages } : {}),
    toolHints,
    metadata,
  };
};
