# Use OpenClaw as the Brain for Your Mutiro Agent

Copy the prompt below into your AI assistant (Claude, Cursor, Windsurf, or similar) and it will walk you through pointing [OpenClaw](https://openclaw.ai) at a [Mutiro](https://mutiro.com) agent through `chatbridge`. Mutiro stays the messaging platform; OpenClaw becomes the brain.

## The Prompt

````
You are helping me run an existing Mutiro agent with OpenClaw as its brain over `chatbridge`. Mutiro keeps the agent identity, connectivity, messaging, auth, and media plumbing. OpenClaw becomes the thinking layer and drives outbound replies through the bridge.

Walk me through this step by step. Be proactive — run commands, check outputs, and make smart decisions based on what you find. Don't ask me things you can figure out by running a command. Only pause to ask when you genuinely need my input (like which LLM provider to use or what personality I want). When you need my input, ask me directly and wait for my response.

**Important:** Both CLIs have extensive built-in help. Use `mutiro --help`, `openclaw --help`, and their `<command> --help` variants. Check the CLI help first rather than guessing.

---

### Step 1: Make Sure a Mutiro Agent Exists

This guide assumes I already have a working Mutiro agent directory. If I don't, stop and point me at the Mutiro create-agent guide first:

> https://www.mutiro.com/docs/guides/create-agent.md

Check what's already set up:

```bash
mutiro auth whoami
mutiro agents list
```

If either fails, walk me through that guide first and come back here.

Once I have an agent, ask me which one I want to wire into OpenClaw, then confirm the agent directory path. The agent directory is the folder containing `.mutiro-agent.yaml`.

Record the absolute path — every later step uses it.

---

### Step 2: Stop the Built-in Mutiro Brain

**Do not run the built-in Mutiro brain and OpenClaw against the same agent at the same time.** Two brains on one agent will fight over the same conversations.

If Mutiro's built-in brain is currently running for that agent, stop it:

```bash
# Inside the agent directory
cd /path/to/agent-directory
pkill -f "mutiro agent run" || true
# Or, if you launched it with `mutiro start`, stop that process.
```

Verify nothing is holding the agent:

```bash
mutiro agent doctor
```

---

### Step 3: Install the OpenClaw CLI

Check if it's already installed:

```bash
openclaw --version
```

If not found, install it:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Or, if I already use npm globally:

```bash
npm i -g openclaw@latest
```

Verify before continuing:

```bash
openclaw --version
openclaw doctor
```

---

### Step 4: Install the openclaw-brain Plugin

This plugin is the piece that lets OpenClaw speak Mutiro's `chatbridge`. It spawns `mutiro agent host --mode=bridge` as a subprocess and translates NDJSON envelopes into OpenClaw inbound messages and outbound send/react/forward/voice/card/forward calls.

Install from the published package (once published):

```bash
openclaw plugins install @mutirolabs/openclaw-brain
```

Or clone and install from source while iterating:

```bash
git clone https://github.com/mutirolabs/openclaw-brain ~/src/openclaw-brain
cd ~/src/openclaw-brain
npm install
openclaw plugins install "file:$(pwd)"
```

Verify OpenClaw sees the channel:

```bash
openclaw plugins list | grep -i mutiro
openclaw channels list | grep -i mutiro
```

---

### Step 5: Point OpenClaw at the Mutiro Agent Directory

Use the single-account shorthand if I only have one Mutiro agent:

```bash
openclaw config set channels.mutiro.accounts.default.agentDir /absolute/path/to/agent-directory
openclaw config set channels.mutiro.enabled true --strict-json
```

For multiple Mutiro agents, use named accounts:

```bash
openclaw config set channels.mutiro.accounts.coach.agentDir /path/to/coach-agent
openclaw config set channels.mutiro.accounts.assistant.agentDir /path/to/assistant-agent
```

The plugin will spawn one `mutiro agent host --mode=bridge` process per configured account and keep it alive across conversations.

Confirm the config was written:

```bash
openclaw config get channels.mutiro
```

---

### Step 6: Pick an LLM Provider for OpenClaw

OpenClaw runs its own agent with its own system prompt, tools, and provider. The Mutiro `.mutiro-agent.yaml` provider settings are ignored while OpenClaw is the brain — Mutiro is just the messaging surface.

Check what provider keys are already in my environment:

```bash
echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+set}" \
     "OPENAI_API_KEY=${OPENAI_API_KEY:+set}" \
     "GEMINI_API_KEY=${GEMINI_API_KEY:+set}" \
     "GOOGLE_API_KEY=${GOOGLE_API_KEY:+set}"
```

If one is set, suggest using that provider. Otherwise ask:

| Provider | Best for | Env var |
|----------|----------|---------|
| Anthropic Claude | Reasoning, coding, careful tool use | `ANTHROPIC_API_KEY` |
| OpenAI | GPT models, broad ecosystem | `OPENAI_API_KEY` |
| Google Gemini | Fast, good free tier | `GEMINI_API_KEY` |
| Ollama | Local/private | (no key) |
| LM Studio | Local/private, GUI | (no key) |

Configure the default model with whatever OpenClaw expects for that provider (check `openclaw models --help`). For example:

```bash
openclaw models auth login --provider anthropic
openclaw models set-default anthropic/claude-opus-4-7
```

If the provider requires no auth (Ollama, LM Studio), point OpenClaw at the local endpoint with `openclaw models` commands and skip the login step.

---

### Step 7: Write the Agent Instructions (OpenClaw Side)

OpenClaw's agent is configured through OpenClaw — not through `.mutiro-agent.yaml`. Its system prompt shapes how the brain thinks, what tools it reaches for, and how it speaks back through the bridge.

Ask me the same framing questions as a normal agent setup — you can ask them all at once:

1. **Role:** What should this agent do? (coach, coding helper, research agent, etc.)
2. **Personality:** Tone and style in chat.
3. **Language:** Primary language for conversation.
4. **Voice:** Should it send voice replies through Mutiro TTS? (if yes, pick a voice — same IDs as the Mutiro create-agent guide: `en-US-Chirp3-HD-Orus`, `en-US-Chirp3-HD-Zephyr`, `pt-BR-Chirp3-HD-Callirrhoe`, etc.)

Write the system prompt into the OpenClaw agent's instruction file (check `openclaw agents --help` for the exact path — typically `~/.openclaw/agents/<agent-id>/system.md` or a configured system prompt field). Follow the same structure as Mutiro's create-agent guide:

```markdown
# <Agent Name> — <One-line role>

## Who You Are
<identity and personality in 2–3 sentences>

## Your Mission
<what this agent exists to do>

## How You Communicate
<tone, length, style — remember replies go through chat>

## What You Do
<core behaviors>

## Rules
<hard constraints, especially tool usage>
```

---

### Step 8: Enable the Mutiro Channel Tools for the Agent

The openclaw-brain plugin ships three extra agent tools on top of the built-in reply surface:

| Tool | Purpose |
|------|---------|
| `mutiro_send_voice_message` | Reply with a host-synthesized voice message (TTS stays inside Mutiro). |
| `mutiro_send_card` | Send an interactive A2UI card (v0.8 JSONL). |
| `mutiro_forward_message` | Forward an existing message to another conversation or user. |

These are **channel-scoped agent tools**. They live in a different registry from regular plugin tools, which means the `alsoAllow` list has to match the tool names exactly or via a tool-name glob — group names like `mutiro` or `group:plugins` silently block.

Correct forms:

```yaml
tools:
  profile: messaging          # baseline: message, sessions_*, session_status
  alsoAllow:
    - "mutiro*"               # glob — enables all Mutiro tools
    # or, explicitly:
    - mutiro_send_voice_message
    - mutiro_send_card
    - mutiro_forward_message
```

Apply that to the agent's config (use `openclaw agents ...` or edit the agent YAML, depending on how the agent was set up). If I skip this step the agent can still reply with plain text but voice/card/forward tools will be unavailable.

---

### Step 9: Start OpenClaw

```bash
openclaw gateway run
```

Watch the logs for these signals:

- `channel=mutiro account=default started` — the plugin spawned `mutiro agent host --mode=bridge`.
- `bridge handshake ok` — `session.initialize` and `subscription.set` completed.
- No `Handshake failed` or `Host error` lines.

If this is a local checkout and new source files were added recently, force a rebuild:

```bash
OPENCLAW_FORCE_BUILD=1 openclaw gateway run
```

OpenClaw runs from its built output — dirty-tree detection only looks at `.ts`/`.js` files, so brand-new files in the plugin may not trigger a rebuild on their own.

---

### Step 10: Test It

Talk to the agent from any Mutiro surface:

- **Web app:** https://app.mutiro.com — sign in and open the conversation with the agent
- **CLI chat:** `mutiro chat` — terminal UI
- **Mobile:** Mutiro app on iOS and Android
- **Desktop:** Mutiro desktop app on macOS, Windows, Linux

Or send a quick test message from the shell:

```bash
mutiro user message send <agent-username> "Hello! Who are you?"
```

Within a second or two I should see:

- a typing/thinking signal on the Mutiro UI (from `signal.emit`)
- the agent reply threaded under my message
- OpenClaw logs showing `message.observed` → reply dispatch → `message.send` → `turn.end`

If no reply lands, jump to the troubleshooting section below.

---

### Step 11: Iterate

- **Wrong tone or behavior?** → Edit the OpenClaw system prompt and restart the gateway.
- **Missing capability?** → Add the tool to the agent's `alsoAllow` list (remember: exact name or `mutiro*` glob for channel tools).
- **Wrong model?** → Change the default via `openclaw models set-default`.
- **Agent hangs or double-replies?** → Make sure the built-in Mutiro brain is not also running against the same agent.

Restart with `openclaw gateway run` after any config change.

---

### Step 12: Signals and Live Call Handoff

OpenClaw's tool activity is forwarded to Mutiro as bridge signals, so Mutiro surfaces "thinking", "web searching", "recalling", "sending voice", etc. in real time while the agent works. The plugin maps 26 OpenClaw tool names to Mutiro `SignalType` enums; anything outside the map falls back to `SIGNAL_TYPE_CUSTOM` with a detail label.

For live voice calls, Mutiro sends `task.request` with a compact observed-turn payload and expects a plain-text result. The plugin handles this by accumulating the agent's reply text and returning it as `ChatBridgeTaskResult.text`. It also answers `session.snapshot` from recent messages cached per-conversation so Mutiro can bootstrap the live lane.

Voice call **summaries** flow as normal `message.observed` envelopes tagged `live_call`. OpenClaw treats them as regular inbound turns — nothing extra to configure.

---

### Step 13: Troubleshooting

These are the six silent-fail gotchas that cause most first-run issues. Walk through them in order:

**1. "Unknown target conv_..."** — The plugin exposes a `targetResolver` that recognizes `conv_*` conversation IDs and `@username` direct sends. If you see this error, the plugin probably did not load; check `openclaw plugins list` and rebuild.

**2. "Channel mutiro is unavailable for message actions"** — Reactions rely on the plugin's message-action adapter. Same cause as (1) — plugin not registered. Rebuild and restart.

**3. Agent can't use `mutiro_send_voice_message`, `mutiro_send_card`, or `mutiro_forward_message`** — The `alsoAllow` list uses the wrong form. Channel agent tools need exact names or `mutiro*` glob. `mutiro` (group name) silently blocks because channel tools use a separate metadata registry.

**4. Media upload succeeds but the reply fails with "path not allowed"** — OpenClaw's sandbox rejects any media path outside `~/.openclaw/media/`. Do not stage files to `/tmp/`; use `saveMediaBuffer` (already wired inside the plugin).

**5. New plugin source files are ignored** — The gateway runs from `dist/`, and dirty-tree detection only inspects `.ts`/`.js`. Force a rebuild with `OPENCLAW_FORCE_BUILD=1 openclaw gateway run` after adding new files.

**6. Gateway loops restarting the channel** — Usually means `startAccount` resolved early and was interpreted as "channel exited". The plugin fixes this by returning a lifecycle `Promise` that only resolves on host exit or abort; if you are on an older version, update.

**Log inspection:**

```bash
openclaw channels status --probe
openclaw channels logs --channel mutiro
openclaw doctor
```

---

### Step 14: Security

OpenClaw-as-brain inherits both sides' risk surface:

- Every Mutiro message, forwarded content, voice transcript, and uploaded file is potential prompt-injection input.
- OpenClaw's tool set defines the blast radius if an injection succeeds.

Apply the same Exposure × Blast Radius thinking as the Mutiro create-agent guide:

- **Personal agent, only you message it:** defaults are fine. Still careful with forwarded content.
- **Shared with trusted people:** keep memory writes scoped; prefer per-user workspace isolation.
- **Open to everyone:** restrict OpenClaw tools to reply-only — no file writes, no memory writes, no web fetch.
- **Agent fetches untrusted web content:** separate it into a "research" agent (reads web, reports back) and an "action" agent (only takes instructions from you).

The lethal combination: (1) ingests untrusted data, (2) takes consequential actions, (3) runs without human oversight. Do not build one agent that is all three.

Help me review OpenClaw's `tools.profile` / `tools.alsoAllow` and the Mutiro `allowlist` together — the weakest link decides the real risk.

---

### Reference

**OpenClaw commands:**
- `openclaw plugins list` — show installed plugins
- `openclaw channels list` — show registered channels
- `openclaw channels status --probe` — live channel health
- `openclaw channels logs --channel mutiro` — plugin logs
- `openclaw config get channels.mutiro` — view bridge config
- `openclaw gateway run` — start the gateway
- `openclaw doctor` — diagnose
- `openclaw agents --help` — agent setup options

**Mutiro commands:**
- `mutiro agents list` — see your agents
- `mutiro agents get <username>` — agent details
- `mutiro agents allowlist get <username>` — who can message it
- `mutiro user message send <agent-username> "<text>"` — send a test message
- `mutiro agent doctor` — diagnose the Mutiro side

**Docs:**
- OpenClaw: https://openclaw.ai
- Mutiro: https://mutiro.com
- Create a Mutiro agent: https://www.mutiro.com/docs/guides/create-agent.md
- openclaw-brain repo: https://github.com/mutirolabs/openclaw-brain
````
