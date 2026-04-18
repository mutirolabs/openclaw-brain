// Bridges OpenClaw's mid-turn reply-dispatch hooks into Mutiro's
// signal.emit envelopes so the user sees a live "typing / searching /
// remembering" indicator while the agent works. Fire-and-forget: signals
// are transient UI chrome, not messages. No correlation required.
//
// Maps OpenClaw callbacks (from GetReplyOptions) to Mutiro's signal
// vocabulary (SIGNAL_TYPE_* in spec/protobuf/shared/signal.proto).

import type { BridgeSession } from "./bridge-session.js";
import type { MutiroOutboundTarget } from "./outbound.js";

const REASONING_DEBOUNCE_MS = 500;
const TOOL_DETAIL_MAX_CHARS = 120;

// Tool-name → Mutiro signal + human-readable "intent" label. The signal
// type drives the UI pill style; the intent is the detail_text prefix
// the user actually reads. Tools without a dedicated SIGNAL_TYPE still
// get a readable intent ("Reading file: src/x.ts") via CUSTOM so the
// user sees what's happening rather than the raw tool name.
type ToolSignalSpec = { signal: string; intent: string };
const TOOL_SIGNAL_MAP: Record<string, ToolSignalSpec> = {
  // Web
  web_search: { signal: "SIGNAL_TYPE_WEB_SEARCHING", intent: "Searching web" },
  web_fetch: { signal: "SIGNAL_TYPE_WEB_FETCHING", intent: "Fetching" },
  fetch: { signal: "SIGNAL_TYPE_WEB_FETCHING", intent: "Fetching" },

  // Memory / recall
  recall: { signal: "SIGNAL_TYPE_RECALLING", intent: "Recalling" },
  memory_search: { signal: "SIGNAL_TYPE_RECALLING", intent: "Searching memory" },
  memory: { signal: "SIGNAL_TYPE_READING_MEMORY", intent: "Reading memory" },
  memory_remember: { signal: "SIGNAL_TYPE_WRITING_MEMORY", intent: "Saving memory" },
  memory_write: { signal: "SIGNAL_TYPE_WRITING_MEMORY", intent: "Saving memory" },

  // Media
  image_generate: { signal: "SIGNAL_TYPE_CREATING_IMAGE", intent: "Creating image" },
  image: { signal: "SIGNAL_TYPE_CREATING_IMAGE", intent: "Working with image" },

  // Scheduling / planning
  cron: { signal: "SIGNAL_TYPE_SCHEDULING", intent: "Scheduling" },
  update_plan: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Updating plan" },

  // Mutiro-native channel tools
  mutiro_send_voice_message: { signal: "SIGNAL_TYPE_SENDING_VOICE", intent: "Sending voice" },
  mutiro_send_card: { signal: "SIGNAL_TYPE_ATTACHING_FILE", intent: "Preparing card" },
  mutiro_forward_message: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Forwarding message" },

  // File operations (coding profile). Mutiro has no dedicated SIGNAL_TYPE_*
  // for file I/O; use CUSTOM + readable intent so the user still sees the
  // action. Phase (e.g. the path being touched) is appended when present.
  read: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Reading file" },
  write: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Writing file" },
  edit: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Editing file" },
  apply_patch: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Applying patch" },

  // Shell / process
  exec: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Running command" },
  bash: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Running command" },
  process: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Managing process" },

  // UI surfaces
  canvas: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Updating canvas" },
  browser: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Browsing" },

  // Sessions / control plane
  sessions_list: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Listing sessions" },
  sessions_history: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Reading history" },
  sessions_send: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Sending to session" },
  session_status: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Checking status" },
  message: { signal: "SIGNAL_TYPE_CUSTOM", intent: "Messaging" },
};

const truncateDetail = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TOOL_DETAIL_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, TOOL_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
};

export type SignalForwarder = {
  thinking: () => void;
  typing: () => void;
  reasoning: () => void;
  toolStart: (name?: string, phase?: string) => void;
  itemStart: (params: { name?: string; title?: string; phase?: string }) => void;
  compactionStart: () => void;
  compactionEnd: () => void;
  planUpdate: (title?: string) => void;
  custom: (detail: string) => void;
  turnComplete: () => void;
};

export const createSignalForwarder = (
  session: BridgeSession,
  target: MutiroOutboundTarget,
): SignalForwarder => {
  let lastReasoningAt = 0;
  const emit = (signalType: string, detail?: string) => {
    session.outbound.emitSignal(target, signalType, detail ?? "");
  };

  return {
    thinking: () => emit("SIGNAL_TYPE_THINKING", "Processing…"),
    typing: () => emit("SIGNAL_TYPE_TYPING", "Writing response…"),
    reasoning: () => {
      // onReasoningStream fires per-token; throttle so we ship at most one
      // REASONING pulse every REASONING_DEBOUNCE_MS to avoid spamming the
      // host + Mutiro clients.
      const now = Date.now();
      if (now - lastReasoningAt < REASONING_DEBOUNCE_MS) return;
      lastReasoningAt = now;
      emit("SIGNAL_TYPE_REASONING", "Thinking…");
    },
    toolStart: (name, _phase) => {
      const trimmedName = (name ?? "").trim();
      if (!trimmedName) {
        emit("SIGNAL_TYPE_TOOL_RUNNING");
        return;
      }
      // `onToolStart.phase` is a lifecycle marker ("start"/"update"/"end"),
      // not semantic payload — ignore it. Tools with args (read, write,
      // exec, etc.) fire a follow-up `onItemEvent` whose `title` carries
      // the real detail (e.g. "read src/x.ts"); itemEvent() refines the
      // pill to that value. For tools that never emit an item event, the
      // intent label alone is still meaningful.
      const spec = TOOL_SIGNAL_MAP[trimmedName];
      const intent = spec?.intent ?? trimmedName;
      emit(spec?.signal ?? "SIGNAL_TYPE_CUSTOM", truncateDetail(intent));
    },
    itemStart: (params) => {
      // Higher-fidelity source than toolStart: title resolves tool args
      // into a display ("read src/x.ts", "exec pytest -k foo", etc.) via
      // OpenClaw's inferToolMetaFromArgs. When we have both the tool
      // signal type AND the rich title, emit with the specific signal
      // type so the UI still shows the right pill style.
      const name = (params.name ?? "").trim();
      const title = (params.title ?? "").trim();
      if (!name && !title) return;
      const spec = name ? TOOL_SIGNAL_MAP[name] : undefined;
      const detail = truncateDetail(title || spec?.intent || name);
      emit(spec?.signal ?? "SIGNAL_TYPE_CUSTOM", detail);
    },
    compactionStart: () => emit("SIGNAL_TYPE_REMEMBERING", "Organizing context…"),
    compactionEnd: () => {
      // No explicit clear — the next signal (or TURN_COMPLETE) replaces the
      // visible pill on Mutiro clients.
    },
    planUpdate: (title) => {
      const detail = (title ?? "").trim();
      emit("SIGNAL_TYPE_CUSTOM", detail ? `Planning: ${truncateDetail(detail)}` : "Planning…");
    },
    custom: (detail) => emit("SIGNAL_TYPE_CUSTOM", truncateDetail(detail)),
    turnComplete: () => emit("SIGNAL_TYPE_TURN_COMPLETE"),
  };
};
