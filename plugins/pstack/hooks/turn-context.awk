# turn-context.sh's JSON work, after json.awk. POSIX awk, run under LC_ALL=C.
# mode=prompt parses the UserPromptSubmit input and prints two lines: "self"
# for a prompt Claude Code sent itself (it opens with a tag) or "user", then
# the transcript path. Input that does not parse prints "user" and no path.
# mode=subagent prints the SubagentStart output: Claude Code passes a
# subagent only hookSpecificOutput.additionalContext, not plain stdout.
BEGIN {
  if (mode == "prompt") {
    if (!jparse()) {
      print "user"
      print ""
      exit
    }
    p = jget("/prompt")
    sub(/^[ \t\r\n]+/, "", p)
    print (substr(p, 1, 1) == "<" ? "self" : "user")
    print jget("/transcript_path")
    exit
  }
  # index and substr, not gsub, so an & or \ in the path is copied as is.
  root = ENVIRON["CLAUDE_PLUGIN_ROOT"]
  file = root "/hooks/subagent-start-context.md"
  out = ""
  first = 1
  while ((getline line < file) > 0) {
    s = ""
    while ((i = index(line, "<root>")) > 0) {
      s = s substr(line, 1, i - 1) root
      line = substr(line, i + 6)
    }
    out = out (first ? "" : "\\n") esc(s line)
    first = 0
  }
  printf "{\"hookSpecificOutput\":{\"hookEventName\":\"SubagentStart\",\"additionalContext\":\"%s\"}}\n", out
}
