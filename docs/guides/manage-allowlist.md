# Manage Who Can Message Your Mutiro Agent

When OpenClaw is the brain, there are **two allowlists** at play and they do different things:

| Layer | What it gates | Where it lives | How to manage |
|-------|--------------|----------------|---------------|
| **Mutiro backend allowlist** | Whether a user's message even reaches your agent. Denied users are blocked at the server — the message never hits the bridge. | Mutiro servers (per agent) | `mutiro agents allowlist …` |
| **OpenClaw `allowFrom`** | Whether your OpenClaw agent *responds* to a message that did reach it. | Your local OpenClaw config | `openclaw config set channels.mutiro.accounts.<id>.allowFrom …` |

If the Mutiro allowlist denies a user, the OpenClaw `allowFrom` never even gets consulted. Tighten whichever layer gives you the semantics you want, but **do not skip the Mutiro layer** — it is the only one that actually prevents delivery.

Copy the prompt below into your AI assistant (Claude, Cursor, Windsurf, or similar) when you want to share or restrict your agent.

## The Prompt

````
You are helping me manage who can message my Mutiro agent. My agent is driven
by OpenClaw over `chatbridge`, so there are two allowlists. The Mutiro backend
allowlist is the authoritative gate — denied users are blocked at the server.
The OpenClaw allowFrom is a second filter on top.

Be proactive — inspect current state before changing anything, and confirm
destructive changes (especially `set` calls that replace the whole list).

---

### Step 1: Figure out which agent

If I haven't told you the agent username, ask me or check what agents I own:

```bash
mutiro agents list
```

Agent usernames end in a Mutiro-assigned suffix (e.g., `my_bot_X1W1`). Use the
full username in every command below.

---

### Step 2: Show the current Mutiro allowlist

Always start by inspecting current state:

```bash
mutiro agents allowlist get <agent-username>
```

Output tells you one of three states:

- Only the owner (me) — no one else can message the agent yet.
- A specific list of usernames — only those users plus me.
- `*` — open to everyone on Mutiro.

Report it back to me before changing anything.

---

### Step 3: Make the change I asked for

Map the request to the right command. Do not guess — match exactly:

**Add one user:**
```bash
mutiro agents allowlist add <agent-username> <username>
```

**Remove one user:**
```bash
mutiro agents allowlist remove <agent-username> <username>
```

**Shorthand for a single allow (same as `allowlist add`):**
```bash
mutiro agents allow <agent-username> <username>
```

**Shorthand for a single deny (same as `allowlist remove`):**
```bash
mutiro agents deny <agent-username> <username>
```

**Replace the entire list** (destructive — confirm with me first):
```bash
mutiro agents allowlist set <agent-username> alice bob charlie
```

**Open to everyone** (destructive — confirm security posture first, see Step 5):
```bash
mutiro agents allowlist set <agent-username> "*"
```

**Reset to owner-only** (removes everyone else):
```bash
mutiro agents allowlist set <agent-username>
```

---

### Step 4: Verify

After any change, re-run `get` and tell me the new state:

```bash
mutiro agents allowlist get <agent-username>
```

---

### Step 5: Security Check (especially for `set "*"` or large additions)

Opening the agent up changes its threat model. Before you run `set "*"` or add
more than a couple of users, walk me through this:

**Exposure × blast radius.** Higher exposure + more powerful tools = more risk.

- What tools does my OpenClaw agent have? Check the agent config. Tools like
  `writeFile`, `memory_write`, `web_fetch`, or anything from the "Dangerous"
  group (`bash`, `process`, `code`) multiply the blast radius of any prompt
  injection.
- Is the agent set up with per-user workspace isolation? Look for
  `workspace: "./${USERNAME}"` in `.mutiro-agent.yaml`. If everyone shares a
  workspace, one user can poison files for everyone.
- Does the agent write to memory? `memory_write` persists across ALL future
  conversations, so a single injection becomes permanent.

If any of those look risky for open access, suggest tightening before setting
`*` — either drop powerful tools, switch to per-user workspace, or keep the
allowlist narrow.

---

### Step 6: Second layer (optional)

If I want a second filter — for example, "Alice can message the agent at the
server level but I want the OpenClaw agent to ignore her for now" — we can add
her to OpenClaw's own `allowFrom` denylist or set a stricter OpenClaw DM
policy. Ask me if that's needed; usually the Mutiro layer is enough.

OpenClaw config lives at `channels.mutiro.accounts.<account-id>.allowFrom`
and is managed via `openclaw config set` or the `openclaw channels add`
wizard.

---

### Reference

- `mutiro agents allowlist get <agent>` — list current allowlist
- `mutiro agents allow <agent> <user>` — add one
- `mutiro agents deny <agent> <user>` — remove one
- `mutiro agents allowlist set <agent> user1 user2 ...` — replace whole list
- `mutiro agents allowlist set <agent> "*"` — open to everyone
- `mutiro agents allowlist set <agent>` — reset to owner-only
- `mutiro agents allowlist add <agent> <user>` — same as `allow`
- `mutiro agents allowlist remove <agent> <user>` — same as `deny`
- `mutiro agents get <agent>` — agent details (owner, created-at, etc.)
- `mutiro agent doctor` — diagnose the Mutiro side
````

## Quick Reference (Humans)

If you don't want to use an AI assistant, the commands are the same:

```bash
# See who has access
mutiro agents allowlist get <agent-username>

# Allow one user
mutiro agents allow <agent-username> <username>

# Remove one user
mutiro agents deny <agent-username> <username>

# Replace the whole list
mutiro agents allowlist set <agent-username> alice bob charlie

# Open to everyone (read the security note in the prompt above first!)
mutiro agents allowlist set <agent-username> "*"

# Reset to owner-only
mutiro agents allowlist set <agent-username>
```

**Remember:** the Mutiro backend allowlist is the authoritative server-side
gate. A denied user's message never reaches your OpenClaw brain at all.
