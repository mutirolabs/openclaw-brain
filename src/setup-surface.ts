// Setup wizard + adapter driven by `openclaw channels add --channel mutiro`
// (and the interactive onboarding flow). The wizard detects the `mutiro` CLI,
// collects the agent directory path, validates that it looks like a real
// Mutiro agent workspace, and checks that auth is configured before writing
// `channels.mutiro.accounts.<id>.agentDir` into the OpenClaw config.

import fs from "node:fs";
import path from "node:path";

import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
  setSetupChannelEnabled,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";

import { listMutiroAccountIds, resolveMutiroAccount } from "./config.js";

const channel = "mutiro" as const;
const INSTALL_URL = "https://mutiro.com/downloads/install.sh";
const CREATE_AGENT_GUIDE = "https://www.mutiro.com/docs/guides/create-agent.md";

const MUTIRO_INTRO_LINES = [
  "Point OpenClaw at an existing Mutiro agent directory.",
  "Mutiro stays the messaging surface; OpenClaw becomes the brain.",
  "",
  "Before continuing:",
  `  1. Create a Mutiro agent: ${CREATE_AGENT_GUIDE}`,
  "  2. Stop the built-in Mutiro brain for that agent — do not run two brains.",
  "",
  `Docs: ${formatDocsLink("/channels/mutiro", "channels/mutiro")}`,
];

type MutiroAccountSection = {
  agentDir?: string;
  clientName?: string;
  enabled?: boolean;
  name?: string;
};

type MutiroSection = {
  accounts?: Record<string, MutiroAccountSection>;
  agentDir?: string;
  clientName?: string;
  enabled?: boolean;
};

function getSection(cfg: OpenClawConfig): MutiroSection {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return (channels?.mutiro as MutiroSection | undefined) ?? {};
}

function isConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const dir = resolveMutiroAccount(cfg, accountId).config.agentDir;
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function patchAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  enabled?: boolean;
}): OpenClawConfig {
  const section = getSection(params.cfg);

  // Single-account shorthand: keep `agentDir` at the top-level section as long
  // as no named accounts exist. This matches the plugin's config shape.
  if (params.accountId === DEFAULT_ACCOUNT_ID && !section.accounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [channel]: {
          ...section,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    } as OpenClawConfig;
  }

  const accounts: Record<string, MutiroAccountSection> = { ...(section.accounts ?? {}) };
  accounts[params.accountId] = {
    ...(accounts[params.accountId] ?? {}),
    ...params.patch,
  };

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [channel]: {
        ...section,
        ...(params.enabled ? { enabled: true } : {}),
        accounts,
      },
    },
  } as OpenClawConfig;
}

function validateAgentDir(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return "Agent directory is required.";

  const resolved = path.resolve(trimmed);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return "Path is not a directory.";
  } catch {
    return "Directory does not exist. Create the Mutiro agent first.";
  }

  const manifest = path.join(resolved, ".mutiro-agent.yaml");
  if (!fs.existsSync(manifest)) {
    return ".mutiro-agent.yaml not found. Is this the correct agent directory?";
  }

  return undefined;
}

export const mutiroSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID,
  validateInput: ({ input }) => {
    const raw = input.authDir?.trim();
    if (!raw) {
      return "Mutiro requires --auth-dir (path to the Mutiro agent directory).";
    }
    return validateAgentDir(raw) ?? null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) =>
    patchAccount({
      cfg,
      accountId,
      enabled: true,
      patch: { agentDir: path.resolve((input.authDir ?? "").trim()) },
    }),
};

export const mutiroSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Mutiro",
    configuredLabel: "configured",
    unconfiguredLabel: "needs agent directory",
    configuredHint: "agent directory set",
    unconfiguredHint: "point at a Mutiro agent dir",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      accountId
        ? isConfigured(cfg, accountId)
        : listMutiroAccountIds(cfg).some((id) => isConfigured(cfg, id)),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listMutiroAccountIds(cfg).length || 0}`],
  }),
  introNote: {
    title: "Mutiro chatbridge setup",
    lines: MUTIRO_INTRO_LINES,
  },
  prepare: async ({ prompter }) => {
    const cliDetected = await detectBinary("mutiro");
    if (cliDetected) return undefined;

    await prompter.note(
      [
        "mutiro CLI not found on PATH.",
        "",
        "Install it:",
        `  curl -sSL ${INSTALL_URL} | bash`,
        "",
        "Then log in and create (or pick) an agent:",
        "  mutiro auth login <email>",
        '  mutiro agents create <username> "<Display Name>" --engine genie --bio "<bio>"',
        "",
        `Guide: ${CREATE_AGENT_GUIDE}`,
      ].join("\n"),
      "Mutiro CLI required",
    );
    return undefined;
  },
  credentials: [],
  textInputs: [
    {
      inputKey: "authDir",
      message: "Path to your Mutiro agent directory",
      placeholder: "/Users/you/agents/my-agent",
      required: true,
      helpTitle: "Mutiro agent directory",
      helpLines: [
        "The folder that contains `.mutiro-agent.yaml` for the agent OpenClaw",
        "should drive. Each configured account points to one agent directory.",
        "",
        "If you don't have one yet:",
        '  mutiro agents create <username> "<Display Name>" --engine genie --bio "<bio>"',
        `Guide: ${CREATE_AGENT_GUIDE}`,
      ],
      currentValue: ({ cfg, accountId }) =>
        resolveMutiroAccount(cfg, accountId).config.agentDir,
      keepPrompt: (value) => `Agent directory set (${value}). Keep it?`,
      validate: ({ value }) => validateAgentDir(value),
      normalizeValue: ({ value }) => path.resolve(value.trim()),
      applySet: async ({ cfg, accountId, value }) =>
        patchAccount({
          cfg,
          accountId,
          enabled: true,
          patch: { agentDir: path.resolve(value.trim()) },
        }),
    },
  ],
  finalize: async ({ cfg, accountId, prompter }) => {
    const dir = resolveMutiroAccount(cfg, accountId).config.agentDir;
    if (!dir) return undefined;

    const whoami = await runPluginCommandWithTimeout({
      argv: ["mutiro", "auth", "whoami"],
      timeoutMs: 5_000,
      cwd: dir,
    });

    if (whoami.code !== 0) {
      await prompter.note(
        [
          "Could not confirm `mutiro auth whoami`.",
          "",
          "Finish Mutiro-side setup before starting the gateway:",
          `  cd ${dir}`,
          "  mutiro auth login <email>",
          "",
          "Also make sure the built-in Mutiro brain is NOT running for this agent —",
          "running two brains at once will fight over the same conversations:",
          "  mutiro agent doctor",
        ].join("\n"),
        "Mutiro agent readiness",
      );
    }

    return undefined;
  },
  completionNote: {
    title: "Mutiro bridge configured",
    lines: [
      "Next steps:",
      "  1. Stop the built-in Mutiro brain for this agent (don't run two brains).",
      "  2. Allow Mutiro tools on the OpenClaw agent by adding `mutiro*` to",
      "     `tools.alsoAllow` (or enable individually: mutiro_send_voice_message,",
      "     mutiro_send_card, mutiro_forward_message).",
      "  3. Start the gateway:  openclaw gateway run",
      "",
      "Once the gateway is running, talk to your agent:",
      "  Web:     https://app.mutiro.com",
      "  CLI:     mutiro chat",
      "  Mobile:  Mutiro app (iOS / Android)",
      "  Desktop: Mutiro desktop app (macOS / Windows / Linux)",
      "",
      "Sharing the agent with other users:",
      "  Mutiro has its own server-side allowlist — denied users are blocked",
      "  before their messages ever reach OpenClaw. Manage it with:",
      "    mutiro agents allowlist get <agent-username>",
      "    mutiro agents allow <agent-username> <username>",
      "  Full guide (paste into your AI assistant):",
      "    https://github.com/mutirolabs/openclaw-brain/blob/main/docs/guides/manage-allowlist.md",
      "",
      `Docs: ${formatDocsLink("/channels/mutiro", "channels/mutiro")}`,
    ],
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
