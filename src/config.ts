// Mutiro channel configuration and per-account resolution.
//
// The channel supports one or more named accounts; each account pins a
// specific Mutiro agent directory that `mutiro agent host --mode=bridge`
// should run from. We reuse OpenClaw's `createScopedChannelConfigAdapter` so
// the account lifecycle (list/default/resolve) flows through the same shape
// the Plugin SDK already knows how to drive.

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";

export { DEFAULT_ACCOUNT_ID };

export type MutiroAccountConfig = {
  agentDir: string;
  clientName?: string;
  requestedOptionalCapabilities?: string[];
  enabled?: boolean;
  name?: string;
};

export type ResolvedMutiroAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config: MutiroAccountConfig;
};

type MutiroChannelSection = {
  accounts?: Record<string, MutiroAccountConfig & { name?: string; enabled?: boolean }>;
  // Support single-account shorthand by keeping top-level fields too.
  agentDir?: string;
  clientName?: string;
  requestedOptionalCapabilities?: string[];
  enabled?: boolean;
};

const readMutiroSection = (cfg: OpenClawConfig): MutiroChannelSection | undefined => {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return channels?.mutiro as MutiroChannelSection | undefined;
};

const resolveAccountConfig = (
  cfg: OpenClawConfig,
  accountId: string,
): MutiroAccountConfig | undefined => {
  const section = readMutiroSection(cfg);
  if (!section) return undefined;

  if (accountId === DEFAULT_ACCOUNT_ID && section.agentDir) {
    return {
      agentDir: section.agentDir,
      clientName: section.clientName,
      requestedOptionalCapabilities: section.requestedOptionalCapabilities,
      enabled: section.enabled,
    };
  }

  return section.accounts?.[accountId];
};

export const listMutiroAccountIds = (cfg: OpenClawConfig): string[] => {
  const section = readMutiroSection(cfg);
  const named = Object.keys(section?.accounts ?? {});
  if (named.length > 0) return named;
  return section?.agentDir ? [DEFAULT_ACCOUNT_ID] : [];
};

export const resolveDefaultMutiroAccountId = (cfg: OpenClawConfig): string => {
  const ids = listMutiroAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
};

export const resolveMutiroAccount = (
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedMutiroAccount => {
  const id = accountId || resolveDefaultMutiroAccountId(cfg);
  const base = resolveAccountConfig(cfg, id) ?? { agentDir: "" };
  const configured = Boolean(base.agentDir);
  return {
    accountId: id,
    enabled: base.enabled !== false,
    configured,
    name: base.name,
    config: base,
  };
};

// Build the ChannelConfigAdapter directly. The helpers in
// `channel-config-helpers` expect allowlist and clear-base-field accessors
// that Mutiro does not use, so we wire the two required hooks manually.
export const mutiroConfigAdapter: ChannelPlugin<ResolvedMutiroAccount>["config"] = {
  listAccountIds: listMutiroAccountIds,
  resolveAccount: resolveMutiroAccount,
  defaultAccountId: resolveDefaultMutiroAccountId,
  isEnabled: (account: ResolvedMutiroAccount) => account.enabled,
  isConfigured: (account: ResolvedMutiroAccount) => account.configured,
};
