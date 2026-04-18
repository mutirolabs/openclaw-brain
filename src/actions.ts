// Message-action adapter for the shared `message` tool. Teaches OpenClaw
// which actions our plugin handles (react, forward) and dispatches them
// into the bridge via `channel.runtime.ts`. Without this adapter the tool
// rejects with "Channel mutiro is unavailable for message actions".
//
// Kept compact: `describeMessageTool` returns a fixed action list, and
// `handleAction` does a dynamic import so the heavy runtime stays off the
// hot plugin-registration path.

import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";

const MUTIRO_HANDLED_ACTIONS: readonly ChannelMessageActionName[] = [
  "react",
] as const;

const MUTIRO_HANDLED_ACTION_SET = new Set<ChannelMessageActionName>(MUTIRO_HANDLED_ACTIONS);

const readStringArg = (
  params: Record<string, unknown>,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
};

export const mutiroMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({
    actions: MUTIRO_HANDLED_ACTIONS,
    capabilities: [],
  }),

  supportsAction: ({ action }) => MUTIRO_HANDLED_ACTION_SET.has(action),

  handleAction: async (ctx: ChannelMessageActionContext) => {
    const { handleMutiroMessageAction } = await import("./channel.runtime.js");
    return handleMutiroMessageAction({
      action: ctx.action,
      params: ctx.params,
      accountId: ctx.accountId ?? undefined,
      readStringArg,
    });
  },
};
