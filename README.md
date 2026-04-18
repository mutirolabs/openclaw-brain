# Mutiro Channel for OpenClaw

The official Mutiro Channel extension for OpenClaw.

OpenClaw handles the cognition. Mutiro handles the messaging surface, identity, and state.

![Mutiro UI with OpenClaw Badge](docs/assets/mutiro-openclaw-ui.png)

## Why this exists

Sovereign intelligence deserves a professional interface. Hiding a powerful OpenClaw brain behind a generic Telegram bot or a clunky webview breaks the user experience and obscures ownership. This extension implements an OpenClaw Channel that connects your agent to Mutiro's native clients (Desktop, Mobile, Web, CLI), enforcing the `by @owner` accountability standard out of the box.

## Prerequisites

You need a Mutiro agent before installing the channel. Confirm each check below:

| Check | Fix if it fails |
|-------|-----------------|
| `mutiro version` prints a version | `curl -sSL https://mutiro.com/downloads/install.sh \| bash` |
| `mutiro auth whoami` prints your username | `mutiro auth signup <email> <username> "<Display Name>"` |
| `mutiro agents list` shows an agent you own | `mutiro agents create <username> "<Display>" --engine genie --badge lobster` |
| `mutiro agent host status` reports no running host | Stop whichever process started the host — two brains on one agent will race on every turn |

Pass `--badge lobster` when creating the agent to mark it as OpenClaw-powered in every Mutiro client. For an existing agent: `mutiro agents update-profile <agent-username> --badge lobster`.

New to Mutiro? Follow the [create-agent guide](https://www.mutiro.com/docs/guides/create-agent.md), or paste this into your AI assistant:

> Read https://mutiro.com/docs/guides/create-agent.md and help me create an agent step by step.

## Quick Start

Install the Mutiro channel using OpenClaw's native extension manager:

```bash
openclaw plugins install --dangerously-force-unsafe-install @mutirolabs/openclaw-brain
```

> The flag is required because this extension launches a Mutiro host process to carry the channel. Install only from the signed [`@mutirolabs/openclaw-brain`](https://github.com/mutirolabs/openclaw-brain) source.

Add the channel:

```bash
openclaw channels add
```

Pick `mutiro` from the list. The setup wizard detects the Mutiro CLI, validates your agent directory, and confirms you are authenticated.

Start the gateway:

```bash
openclaw gateway run
```

Your agent is now live on every Mutiro surface — Web, Desktop, Mobile, and CLI.

Send a smoke-test message:

```bash
mutiro user message send <agent-username> "Hello! Who are you?"
```

## Enable Mutiro-native tools

To let your OpenClaw agent send voice messages, interactive cards, or forward messages through Mutiro, add `mutiro*` to your agent's `tools.alsoAllow`:

```yaml
tools:
  profile: messaging
  alsoAllow:
    - "mutiro*"
```

## Access control, enforced at the edge

Mutiro runs the allowlist on its servers — not in your agent. Denied users are rejected before their messages reach OpenClaw, so agent-side bugs can never leak access to someone who shouldn't have it. This is a stronger posture than in-agent filtering and a real differentiator over generic bot channels.

One extra CLI step buys you that posture:

```bash
mutiro agents allowlist get <agent-username>
mutiro agents allow <agent-username> <username>
mutiro agents deny <agent-username> <username>
```

As adoption grows, we may expose the allowlist directly through the OpenClaw channel. For now it stays behind the `mutiro` CLI — a deliberate boundary that keeps access control outside the agent sandbox.

## Resources

- [Use OpenClaw as brain](./docs/guides/use-openclaw-as-brain.md)
- [Manage the Mutiro allowlist](./docs/guides/manage-allowlist.md)
- [Mutiro documentation](https://mutiro.com/docs)
- [OpenClaw documentation](https://openclaw.ai)
