#!/bin/sh
set -eu

# Claude Code and Codex (#264). `prompt` runs on UserPromptSubmit and reminds
# the model of the routing bar until poteto-mode has been opened in the
# session. `subagent` runs on SubagentStart and points a worker subagent at
# the principles, since neither runtime fires SessionStart for a subagent.
# The prompt reminder is plain stdout; the subagent context is JSON, the only
# form Claude Code passes to a subagent (turn-context.awk).
case "${1:-} ${2:-}" in
  "claude prompt" | "claude subagent" | "codex prompt" | "codex subagent") ;;
  *)
    echo "turn-context.sh: expected <claude|codex> <prompt|subagent>, got '${1:-} ${2:-}'" >&2
    exit 2
    ;;
esac
runtime=$1
event=$2

# The same off switch as session-start.sh: a sheet that cannot be decoded
# leaves injection on.
case "$runtime" in
  claude) sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md" ;;
  codex) sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md" ;;
esac
reader="${CLAUDE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
if [ -f "$sheet" ] && [ -r "$sheet" ] && normalized=$(sh "$reader" "$sheet") &&
  printf '%s\n' "$normalized" | grep -qx 'session hook: off'; then
  exit 0
fi

hooks="${CLAUDE_PLUGIN_ROOT}/hooks"

if [ "$event" = subagent ]; then
  cat >/dev/null
  LC_ALL=C awk -v mode=subagent -f "$hooks/json.awk" -f "$hooks/turn-context.awk" </dev/null
  exit 0
fi

parsed=$(LC_ALL=C awk -v mode=prompt -f "$hooks/json.awk" -f "$hooks/turn-context.awk")
# A prompt the runtime sends itself, such as a background agent's report, and
# a Codex subagent's own prompts start no new task for the router.
if [ "$(printf '%s\n' "$parsed" | sed -n 1p)" = skip ]; then
  exit 0
fi

# Once the transcript shows poteto-mode opened, the reminder has done its job.
# On Claude Code that is the Skill tool, the slash command, or a read of its
# file. Codex names every skill's SKILL.md in each turn's context, so there
# only an injected skill or a tool call naming the file counts; a tool call's
# arguments are JSON inside JSON, so a Windows path's separator shows as a run
# of backslashes. A transcript
# that cannot be read leaves the reminder on.
opened() {
  case "$runtime" in
    claude)
      grep -qF -e '"skill":"pstack:poteto-mode"' -e '<command-name>/pstack:poteto-mode<' -e 'poteto-mode/SKILL.md' "$1"
      ;;
    codex)
      grep -qF '<name>pstack:poteto-mode</name>' "$1" ||
        grep -F '"type":"function_call"' "$1" | grep -qE 'poteto-mode(/|\\+)SKILL\.md'
      ;;
  esac
}
transcript=$(printf '%s\n' "$parsed" | sed -n 2p)
if [ -n "$transcript" ] && [ -f "$transcript" ] && [ -r "$transcript" ] && opened "$transcript"; then
  exit 0
fi

cat "$hooks/prompt-reminder.md"
