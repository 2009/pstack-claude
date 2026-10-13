#!/bin/sh
set -eu

# Claude Code only (#264). `prompt` runs on UserPromptSubmit and reminds the
# model of the routing bar until poteto-mode has been opened in the session.
# `subagent` runs on SubagentStart and points a worker subagent at the
# principles, since SessionStart does not fire for subagents. The prompt
# reminder is plain stdout; the subagent context must be JSON (turn-context.awk).
case "${1:-}" in
  prompt | subagent) ;;
  *)
    echo "turn-context.sh: unknown event '${1:-}' (expected prompt or subagent)" >&2
    exit 2
    ;;
esac

# The same off switch as session-start.sh: a sheet that cannot be decoded
# leaves injection on.
sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md"
reader="${CLAUDE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
if [ -f "$sheet" ] && [ -r "$sheet" ] && normalized=$(sh "$reader" "$sheet") &&
  printf '%s\n' "$normalized" | grep -qx 'session hook: off'; then
  exit 0
fi

hooks="${CLAUDE_PLUGIN_ROOT}/hooks"

if [ "$1" = subagent ]; then
  cat >/dev/null
  LC_ALL=C awk -v mode=subagent -f "$hooks/json.awk" -f "$hooks/turn-context.awk" </dev/null
  exit 0
fi

parsed=$(LC_ALL=C awk -v mode=prompt -f "$hooks/json.awk" -f "$hooks/turn-context.awk")
# A prompt Claude Code sends itself, such as a background agent's report,
# starts no new task.
if [ "$(printf '%s\n' "$parsed" | sed -n 1p)" = self ]; then
  exit 0
fi

# Once the transcript shows poteto-mode opened, by the Skill tool, the slash
# command, or a read of its file, the reminder has done its job. A transcript
# that cannot be read leaves the reminder on.
transcript=$(printf '%s\n' "$parsed" | sed -n 2p)
if [ -n "$transcript" ] && [ -f "$transcript" ] && [ -r "$transcript" ] &&
  grep -qF -e '"skill":"pstack:poteto-mode"' -e '<command-name>/pstack:poteto-mode<' -e 'poteto-mode/SKILL.md' "$transcript"; then
  exit 0
fi

cat "$hooks/prompt-reminder.md"
