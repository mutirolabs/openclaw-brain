# Mutiro OpenClaw Channel Reference

Use this repo if you want to plug [OpenClaw](https://openclaw.ai) into a Mutiro agent over `chatbridge`, so OpenClaw becomes the external brain and Mutiro becomes just another OpenClaw channel.

This is the OpenClaw-shaped sibling of [`../pi-brain`](../pi-brain). The bridge codec is a faithful port of `mutiro-pi-bridge.ts`; the brain side is structured as an OpenClaw third-party channel plugin instead of a one-off standalone adapter.

## Quick Start

### 1. Create a Mutiro agent

```text
Read this page from the Mutiro docs: https://mutiro.com/docs/guides/create-agent.md and help me create an agent step by step.
```

Stop the built-in Mutiro brain for that agent before you run this bridge. Do not run both at the same time.

### 2. Install this plugin into OpenClaw

```bash
openclaw plugins install --dangerously-force-unsafe-install @mutirolabs/openclaw-brain
```

Or, for local development:

```bash
# Skip node_modules if you've run `npm install` here — the install scanner
# walks the source tree and caps at 10k directories.
rm -rf node_modules
openclaw plugins install --dangerously-force-unsafe-install "file:$(pwd)"
```

> **Why the `--dangerously-force-unsafe-install` flag?**
> This plugin legitimately spawns `mutiro agent host --mode=bridge` as a
> subprocess — that is the entire point of the `chatbridge` adapter. OpenClaw's
> install scanner correctly flags any plugin that uses `child_process` as
> sensitive, and requires this flag as an explicit acknowledgement. Before you
> pass it, **confirm you are installing from the signed [mutirolabs/openclaw-brain](https://github.com/mutirolabs/openclaw-brain)
> source** (or the `@mutirolabs/openclaw-brain` npm package). Review the
> `spawn` call at [`src/bridge-client.ts`](./src/bridge-client.ts) if you want
> to see exactly what the plugin executes.

### 3. Configure the channel

The plugin ships a setup wizard. Run:

```bash
openclaw channels add --channel mutiro
```

It will:

- detect the `mutiro` CLI (and point you at the install command if missing)
- ask for your Mutiro agent directory (the folder containing `.mutiro-agent.yaml`)
- validate the directory and run `mutiro auth whoami`
- remind you to stop the built-in Mutiro brain before starting the gateway

Or set the config manually:

```bash
openclaw config set channels.mutiro.accounts.default.agentDir /path/to/agent-directory
```

### 4. Run the OpenClaw gateway

```bash
openclaw gateway run
```

Or use the shortcut:

```bash
./run-brain.sh /path/to/agent-directory
```

### 5. Talk to your agent

Once the gateway is running, your agent is reachable from any Mutiro surface:

- **Web app:** [https://app.mutiro.com](https://app.mutiro.com)
- **CLI chat:** `mutiro chat`
- **Mobile:** Mutiro app on iOS / Android
- **Desktop:** Mutiro desktop app on macOS / Windows / Linux

For a quick shell smoke test:

```bash
mutiro user message send <agent-username> "Hello! Who are you?"
```

### 6. Allow Mutiro-specific agent tools

To let the OpenClaw agent send voice messages, interactive cards, or forward
messages through Mutiro, add `mutiro*` to your agent's `tools.alsoAllow`:

```yaml
tools:
  profile: messaging
  alsoAllow:
    - "mutiro*"
```

See [`docs/guides/use-openclaw-as-brain.md`](./docs/guides/use-openclaw-as-brain.md)
for a full walkthrough.

### 7. Share the agent with other users

Mutiro has a **server-side allowlist** that's separate from OpenClaw's own
`allowFrom`. Denied users are blocked at the Mutiro server — their messages
never reach OpenClaw at all. Manage it with the `mutiro` CLI:

```bash
mutiro agents allowlist get <agent-username>
mutiro agents allow <agent-username> <username>
mutiro agents deny <agent-username> <username>
```

See [`docs/guides/manage-allowlist.md`](./docs/guides/manage-allowlist.md) for
the full command reference and a paste-into-AI prompt you can hand to your
assistant when you want help managing sharing and security posture.

## What This Repo Is

A small reference package showing how to plug OpenClaw into Mutiro `chatbridge` as a channel plugin. Pi is a good reference for swapping Mutiro's brain with a standalone runtime; this one shows the same shape routed through OpenClaw's channel plugin contract.

- `mutiro agent host --mode=bridge` is spawned by the plugin, one process per configured Mutiro agent
- NDJSON envelope traffic is translated into OpenClaw inbound messages and outbound send/react/forward actions
- one subprocess per Mutiro agent, long-lived across conversations
- all outbound chat actions go back through the bridge

## What Is Here

- `index.ts` — plugin entry via `defineBundledChannelEntry`
- `src/bridge-protocol.ts` — NDJSON envelope constants and `@type` URLs
- `src/bridge-messages.ts` — normalized message extraction and observed-turn assembly
- `src/bridge-client.ts` — NDJSON envelope codec plus host subprocess spawn
- `src/bridge-session.ts` — per-conversation observed/task/snapshot handlers
- `src/inbound.ts` — bridge observed message → OpenClaw inbound envelope
- `src/outbound.ts` — OpenClaw outbound adapter → `message.send` / `message.react` / `message.forward`
- `src/channel.ts` — Mutiro channel plugin definition
- `src/channel.runtime.ts` — runtime barrel consumed by the plugin entry
- `src/setup-surface.ts` — setup wizard driven by `openclaw channels add --channel mutiro`
- `src/agent-tools.ts` — `mutiro_send_voice_message`, `mutiro_send_card`, `mutiro_forward_message`
- `src/signal-forwarder.ts` — OpenClaw tool events → Mutiro `signal.emit` (26-entry map)
- `src/live-snapshot.ts` — `session.snapshot` + `task.request` handlers for live call handoff
- `openclaw.plugin.json` — channel manifest
- `run-brain.sh` — convenience launcher that boots OpenClaw's gateway against a Mutiro agent directory
- `docs/guides/use-openclaw-as-brain.md` — end-to-end setup guide
- `docs/guides/manage-allowlist.md` — paste-into-AI guide for Mutiro's server-side allowlist

## Why This Exists

Use this folder as a reference if you want to consume Mutiro's chatbridge from OpenClaw, or another gateway-shaped runtime that already owns its own channel/plugin contract.

It shows how to:

1. Spawn `mutiro agent host --mode=bridge` from inside an OpenClaw channel plugin
2. Complete `ready → session.initialize → subscription.set`
3. Receive `message.observed` and turn it into an OpenClaw inbound envelope
4. Route OpenClaw outbound replies through bridge-local commands (`message.send`, `message.react`, `message.forward`, `media.upload`, `signal.emit`, `recall.search/get`)
5. Finish turns with `turn.end`

## Important Bridge Notes

- `message.send` is a bridge-local command, not a raw backend `SendToConversationRequest`
- the portable payload type is `mutiro.chatbridge.ChatBridgeSendMessageCommand`
- `message.send_voice` is also bridge-local and keeps TTS inside the host
- this reference usually replies by `conversation_id`
- the bridge also supports `to_username` for direct sends

## Adapter Model

The plugin process is an OpenClaw channel. It:

- spawns `mutiro agent host --mode=bridge` (one per configured Mutiro agent directory)
- reads and writes bridge envelopes on stdio
- delivers `message.observed` payloads as OpenClaw inbound messages
- exposes outbound send/react/forward through the standard OpenClaw `ChannelOutboundAdapter`

OpenClaw's agent runtime owns the brain layer. The plugin does not talk to Mutiro SDKs directly; everything portable flows through the chatbridge envelope.

## Supported Bridge Operations

This adapter exercises:

- `message.send`
- `message.send_voice`
- `message.react`
- `message.forward`
- `media.upload`
- `signal.emit`
- `turn.end`
- `recall.search`
- `recall.get`

## Session Model

- one Mutiro `conversation_id` maps to one OpenClaw conversation binding
- later turns in the same conversation reuse the same OpenClaw session, just as pi-brain reuses a Pi session
- `session.snapshot` is answered from recent messages cached per-conversation in the plugin

OpenClaw already owns transcript continuity across turns, so the plugin keeps its own cache narrow — just enough to answer `session.snapshot` for bridge consumers.

## Handshake

Startup flow:

1. host sends `ready`
2. plugin sends `session.initialize`
3. plugin sends `subscription.set`
4. host starts delivering `message.observed`

Per turn:

1. plugin acknowledges `message.observed`
2. plugin dispatches the observed envelope into OpenClaw's inbound pipeline
3. OpenClaw's reply-dispatch drives zero or more outbound bridge operations
4. plugin sends `turn.end`

## Debugging

Useful signals while integrating:

- `Handshake failed`
  Bridge startup or negotiation problem.
- `Host error`
  A bridge request failed outside a pending request path.
- `outbound bridge call failed`
  The plugin reached the bridge and got a real host-side error.

## Type Checking

```bash
npm run check
```

It runs with `skipLibCheck` because the OpenClaw plugin SDK's dependency tree includes external type issues that are not specific to this reference code.

## What To Copy

If you are integrating another gateway-shaped runtime, the most useful pieces to copy are:

- bridge handshake flow (`src/bridge-session.ts` + `src/bridge-client.ts`)
- pending-request correlation by `request_id`
- `message.observed` acknowledgement behavior (ack delivery now, reply later)
- per-conversation recent-message cache for `session.snapshot`
- outbound operation wrappers (`src/outbound.ts`)
- final `turn.end` behavior
