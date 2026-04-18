#!/usr/bin/env bash
# Convenience launcher: points OpenClaw's gateway at a Mutiro agent directory
# and runs it. Equivalent to setting channels.mutiro.accounts.default.agentDir
# manually and then running `openclaw gateway run`.
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
