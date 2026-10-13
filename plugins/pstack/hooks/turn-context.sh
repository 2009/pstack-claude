#!/bin/sh
set -eu

# Claude Code only (#264). `prompt` runs on UserPromptSubmit and reminds the
# model of the routing bar until poteto-mode has been opened in the session.
# `subagent` runs on SubagentStart and points a worker subagent at the
# principles, since SessionStart does not fire for subagents. Plain stdout is
# added to the context as a system reminder.
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

input=$(cat)

if [ "$1" = subagent ]; then
  # index and substr, not gsub, so an & or \ in the path is copied as is.
  LC_ALL=C awk 'BEGIN { root = ENVIRON["CLAUDE_PLUGIN_ROOT"] }
    {
      out = ""
      while ((i = index($0, "<root>")) > 0) {
        out = out substr($0, 1, i - 1) root
        $0 = substr($0, i + 6)
      }
      print out $0
    }' "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start-context.md"
  exit 0
fi

# A prompt Claude Code sends itself, such as a background agent's report,
# opens with a tag and starts no new task.
if printf '%s\n' "$input" | grep -q '"prompt"[[:space:]]*:[[:space:]]*"<'; then
  exit 0
fi

# Once the transcript shows poteto-mode opened, by the Skill tool, the slash
# command, or a read of its file, the reminder has done its job. A transcript
# that cannot be read leaves the reminder on.
transcript=$(printf '%s\n' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -n "$transcript" ] && [ -f "$transcript" ] && [ -r "$transcript" ] &&
  grep -qF -e '"skill":"pstack:poteto-mode"' -e '<command-name>/pstack:poteto-mode<' -e 'poteto-mode/SKILL.md' "$transcript"; then
  exit 0
fi

cat "${CLAUDE_PLUGIN_ROOT}/hooks/prompt-reminder.md"
