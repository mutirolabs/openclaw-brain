// NDJSON protocol constants used by the Mutiro chatbridge envelope.
// These type URLs and helpers mirror the Mutiro bridge's protobuf surface
// envelope-for-envelope.

export const PROTOCOL_VERSION = "mutiro.agent.bridge.v1";

export const TYPE_URLS = {
  addReactionRequest: "type.googleapis.com/mutiro.messaging.AddReactionRequest",
  bridgeCommandResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeCommandResult",
  bridgeInitializeCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeInitializeCommand",
  bridgeMediaUploadCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMediaUploadCommand",
  bridgeSendMessageCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendMessageCommand",
  bridgeSendVoiceMessageCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendVoiceMessageCommand",
  bridgeMessageObservedResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMessageObservedResult",
  bridgeSessionObservedResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSessionObservedResult",
  bridgeSessionSnapshotResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSessionSnapshotResult",
  bridgeSubscriptionSetCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSubscriptionSetCommand",
  bridgeTaskResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTaskResult",
  bridgeTurnEndCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTurnEndCommand",
  forwardMessageRequest: "type.googleapis.com/mutiro.messaging.ForwardMessageRequest",
  recallGetRequest: "type.googleapis.com/mutiro.recall.RecallGetRequest",
  recallSearchRequest: "type.googleapis.com/mutiro.recall.RecallSearchRequest",
  sendSignalRequest: "type.googleapis.com/mutiro.signal.SendSignalRequest",
} as const;

export const DEFAULT_OPTIONAL_CAPABILITIES = [
  "message.send_voice",
  "signal.emit",
  "recall.search",
  "recall.get",
  "media.upload",
  // Advertising session.snapshot opts us into the live-call handoff: the
  // host only sends ChatBridgeSessionSnapshotRequest to brains that
  // declare support. Without this, our resolver never fires and the live
  // voice model starts the call with no persona, no transcript, no tools.
  "session.snapshot",
  // Advertising task.request lets the host delegate one-shot prompts to
  // the brain (e.g. scheduled reminders, background lookups). Our
  // resolver runs the prompt against OpenClaw's agent and returns the
  // accumulated reply text in the ChatBridgeTaskResult envelope.
  "task.request",
];

export const MAX_RECENT_MESSAGES = 30;

export type BridgeExtras = {
  request_id?: string;
  conversation_id?: string;
  message_id?: string;
  reply_to_message_id?: string;
};

export type ObservedTurn = {
  conversationId: string;
  messageId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type BridgeEnvelope = {
  protocol_version: string;
  type: string;
  request_id?: string;
  conversation_id?: string;
  message_id?: string;
  reply_to_message_id?: string;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

export const generateId = () => Math.random().toString(36).substring(2, 15);
