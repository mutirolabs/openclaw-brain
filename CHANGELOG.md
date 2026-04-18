# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Channel setup wizard (`openclaw channels add --channel mutiro`): detects the
  Mutiro CLI, validates the agent directory, runs `mutiro auth whoami`, and
  writes `channels.mutiro.accounts.<id>.agentDir`.
- Host stderr (slog JSON) wrapped into the OpenClaw channel logger so log
  output matches the rest of the gateway stream.
- `docs/guides/use-openclaw-as-brain.md` — end-to-end setup walkthrough.
- `docs/guides/manage-allowlist.md` — paste-into-AI prompt for managing the
  Mutiro server-side allowlist; the setup wizard's completion note points here
  so users know the Mutiro and OpenClaw allowlist layers are separate.

[Unreleased]: https://github.com/mutirolabs/openclaw-brain/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mutirolabs/openclaw-brain/releases/tag/v0.1.0
