# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- README prerequisites and wizard help text now suggest `--badge lobster` on
  `mutiro agents create` so the agent shows the OpenClaw lobster badge in the
  Mutiro UI. For existing agents, `mutiro agents update-profile <username>
  --badge lobster` flips it on after the fact.

## [0.1.0] - 2026-04-18

### Added

- Initial OpenClaw channel plugin for the Mutiro `chatbridge` protocol.
- NDJSON envelope codec ported from `pi-brain`.
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

[Unreleased]: https://github.com/mutirolabs/openclaw-brain/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mutirolabs/openclaw-brain/releases/tag/v0.1.0
