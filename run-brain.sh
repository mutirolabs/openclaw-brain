#!/usr/bin/env bash
# Convenience launcher that mirrors pi-brain/run-brain.sh but boots OpenClaw's
# gateway against a Mutiro agent directory instead of a standalone brain.
#
# Usage: ./run-brain.sh /path/to/agent-directory
set -euo pipefail

agent_dir="${1:-}"
if [[ -z "${agent_dir}" ]]; then
  echo "usage: $0 /path/to/agent-directory" >&2
  exit 1
fi

if [[ ! -d "${agent_dir}" ]]; then
  echo "agent directory does not exist: ${agent_dir}" >&2
  exit 1
fi

resolved_dir="$(cd "${agent_dir}" && pwd)"

openclaw config set channels.mutiro.accounts.default.agentDir "${resolved_dir}"
exec openclaw gateway run
