# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-19

### Added

- Threading adapter: the agent's first reply in a turn threads under the
  inbound message by default (visible quoted pill in every Mutiro client).
  `channels.mutiro.replyToMode` overrides with `off` | `first` | `all` |
  `batched`. `allowExplicitReplyTagsWhenOff: true` keeps agent-directed reply
  markers working when the user opts out.
- `replyToMode` exposed in `openclaw.plugin.json` configSchema.
- Status adapter (`ChannelStatusAdapter.buildAccountSnapshot`):
  `openclaw channels status mutiro` now reports `healthState` (stopped |
  restarting | connecting | healthy), `mode: "bridge"`, and `dbPath`
  pointing at the Mutiro agent workspace.
- Bridge crash backoff: unexpected host exits track a per-account crash
  streak with a 5-minute reset window and hold the gateway lifecycle promise
  through an exponential delay (1s → 2s → 5s → 15s → 60s). Clean exits
  (code 0 or abort) short-circuit immediately. Surfaces `restartPending`,
  `reconnectAttempts`, and structured `lastDisconnect` on the snapshot.
- Setup wizard pre-flight: runs `mutiro agent host status` and warns if a
  Mutiro agent host is already running for this agent before starting the
  gateway.

### Changed

- README rewrite: sharper tagline, hero screenshot (`docs/assets/mutiro-openclaw-ui.png`),
  Prerequisites section folded into the setup wizard, `tools.alsoAllow`
  switched from YAML hand-edit to
  `openclaw config set tools.alsoAllow '["mutiro*"]'`, allowlist reframed
  as an edge-enforced security feature, sibling link to `pi-brain`.
- Doc links drop `.md` suffixes so they render as HTML; `/docs` replaced
  with `/docs/manual` + `/docs/cli`.
- Prerequisites "built-in brain stopped" check now references
  `mutiro agent host status` (runtime liveness) instead of
  `mutiro agent doctor` (which only validates config).
- Internal cleanup: removed `pi-brain` references from source comments
  and changelog.
- User-facing metadata aligned with OpenClaw's "channel" + "extension"
  language: npm `description`, `keywords`, channel `selectionLabel`,
  `blurb`, plugin entry `description`, and the setup wizard title no
  longer leak the internal `chatbridge` protocol name.

### Removed

- Unused `MUTIRO_AGENT_API_KEY` from `openclaw.plugin.json` `channelEnvVars`;
  the chathost reads that env var, not this plugin.

## [0.1.1] - 2026-04-18

### Added

- README prerequisites and wizard help text now suggest `--badge lobster` on
  `mutiro agents create` so the agent shows the OpenClaw lobster badge in the
  Mutiro UI. For existing agents, `mutiro agents update-profile <username>
  --badge lobster` flips it on after the fact.

## [0.1.0] - 2026-04-18

### Added

- Initial OpenClaw Channel extension for Mutiro.
- NDJSON envelope codec for `mutiro.agent.bridge.v1`.
- Subprocess lifecycle for `mutiro agent host --mode=bridge`, one per configured account.
- Inbound pipeline: `message.observed` → OpenClaw reply dispatch.
- Outbound surface: `message.send`, `message.send_voice`, `message.react`,
  `message.forward`, `media.upload`, `signal.emit`, `recall.search`, `recall.get`,
  `turn.end`.
- Live call handoff via `task.request` and `session.snapshot`.
- Agent tools: `mutiro_send_voice_message`, `mutiro_send_card`, `mutiro_forward_message`.
- Signal forwarder: 26-entry OpenClaw-tool → Mutiro signal-enum map with
  rich intent labels from `onItemEvent`.
- Channel setup wizard: detects the Mutiro CLI, validates the agent directory,
  runs `mutiro auth whoami`, and writes `channels.mutiro.accounts.<id>.agentDir`.
  Launched via `openclaw channels add` (no flags — passing `--channel mutiro`
  falls through to the non-interactive adapter and never reaches the wizard).
- Host stderr (slog JSON) wrapped into the OpenClaw channel logger so log
  output matches the rest of the gateway stream.
- `docs/guides/use-openclaw-as-brain.md` — end-to-end setup walkthrough.
- `docs/guides/manage-allowlist.md` — paste-into-AI prompt for managing the
  Mutiro server-side allowlist; the setup wizard's completion note points here
  so users know the Mutiro and OpenClaw allowlist layers are separate.
- README + setup guide document `--dangerously-force-unsafe-install`: the
  plugin legitimately spawns `mutiro agent host --mode=bridge`, so OpenClaw's
  install scanner correctly flags `child_process` usage and requires the flag
  as explicit acknowledgement. Install instructions show the flag with a note
  telling users to verify the source before passing it.
- `@sinclair/typebox` declared as a runtime dependency so OpenClaw's
  `npm install --omit=dev` in the installed plugin directory picks it up;
  without this, plugin registration fails with "Cannot find module
  '@sinclair/typebox'" when loading `src/agent-tools.ts`.
- README Prerequisites section: checklist of Mutiro-side state the plugin
  requires (CLI installed, signed in, agent created, built-in brain stopped)
  with concrete fix commands, plus the paste-into-AI prompt as an alternative
  for users who'd rather have their AI assistant drive the setup.

[Unreleased]: https://github.com/mutirolabs/openclaw-brain/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mutirolabs/openclaw-brain/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mutirolabs/openclaw-brain/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mutirolabs/openclaw-brain/releases/tag/v0.1.0
