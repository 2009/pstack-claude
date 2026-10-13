// Claude Code's UserPromptSubmit and SubagentStart commands, run for real
// (#264): the prompt reminder stops once poteto-mode is open, the subagent
// context names the plugin's own paths, and the sheet's off switch silences both.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills } from "../tools/generate.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

// Without a trailing slash, as Claude Code passes CLAUDE_PLUGIN_ROOT.
const pluginRoot = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const { hooks } = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"));
const reminder = readFileSync(join(pluginRoot, "hooks/prompt-reminder.md"), "utf8");
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const [promptGroup] = hooks.UserPromptSubmit;
const [subagentGroup] = hooks.SubagentStart;

function run(command, input, { sheet = null, root = pluginRoot } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pstack-turn-"));
  try {
    if (sheet !== null) {
      mkdirSync(join(home, ".claude"));
      writeSheet(join(home, ".claude", "pstack-models.md"), sheet);
    }
    const r = spawnSync("sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: root },
      input: typeof input === "function" ? input(home) : input,
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const promptHook = promptGroup.hooks[0].command;
const subagentHook = subagentGroup.hooks[0].command;

// A transcript holding `lines`, and the hook input that points at it.
const withTranscript = (lines, prompt = "fix the login bug") => (home) => {
  const path = join(home, "transcript.jsonl");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, transcript_path: path });
};

describe("UserPromptSubmit reminder", () => {
  test("names only skills that exist", () => {
    const named = [...reminder.matchAll(/pstack:([a-z0-9-]+)/g)].map((m) => m[1]);
    const skills = new Set(agentSkills(join(pluginRoot, "skills")).map(({ name }) => name));
    expect(named).toEqual(["poteto-mode"]);
    expect(named.filter((name) => !skills.has(name))).toEqual([]);
  });

  test("reminds while the transcript shows poteto-mode unopened", () => {
    expect(run(promptHook, withTranscript(['{"type":"user","message":{"content":"hi"}}']))).toEqual({
      status: 0,
      out: reminder,
      err: "",
    });
  });

  // The SessionStart mandate and the reminder itself both name
  // pstack:poteto-mode, so neither may read as the skill being open.
  test("the injected texts do not count as poteto-mode opened", () => {
    const injected = [mandate, reminder].map((content) => JSON.stringify({ type: "attachment", content }));
    expect(run(promptHook, withTranscript(injected)).out).toBe(reminder);
  });

  test("reminds when the transcript is missing or the input names none", () => {
    expect(run(promptHook, JSON.stringify({ prompt: "x", transcript_path: "/nonexistent/t.jsonl" })).out).toBe(reminder);
    expect(run(promptHook, JSON.stringify({ prompt: "x" })).out).toBe(reminder);
  });

  for (const [how, line] of [
    ["the Skill tool", '{"type":"tool_use","name":"Skill","input":{"skill":"pstack:poteto-mode"}}'],
    ["the slash command", '{"type":"user","message":{"content":"<command-name>/pstack:poteto-mode</command-name>"}}'],
    ["a read of its file", '{"type":"tool_use","name":"Read","input":{"file_path":"/p/skills/poteto-mode/SKILL.md"}}'],
  ]) {
    test(`stops once poteto-mode is opened by ${how}`, () => {
      expect(run(promptHook, withTranscript([line]))).toEqual({ status: 0, out: "", err: "" });
    });
  }

  test("decodes an escaped transcript path", () => {
    const input = (home) => {
      const dir = join(home, 'quote"and\\slash');
      mkdirSync(dir);
      const path = join(dir, "t.jsonl");
      writeFileSync(path, '{"type":"tool_use","name":"Skill","input":{"skill":"pstack:poteto-mode"}}\n');
      return JSON.stringify({ prompt: "x", transcript_path: path });
    };
    expect(run(promptHook, input).out).toBe("");
  });

  test("reminds on input that is not one JSON object", () => {
    expect(run(promptHook, '{"prompt": "x"').out).toBe(reminder);
    expect(run(promptHook, "").out).toBe(reminder);
  });

  test("stays quiet on a prompt Claude Code sends itself, after leading whitespace too", () => {
    expect(run(promptHook, withTranscript([], "\n  <task-notification>done</task-notification>")).out).toBe("");
  });

  test("stays quiet on a prompt Claude Code sends itself", () => {
    expect(run(promptHook, withTranscript([], "<task-notification>agent done</task-notification>")).out).toBe("");
  });
});

describe("SubagentStart context", () => {
  const matches = (agentType) => new RegExp(subagentGroup.matcher).test(agentType);

  test("reaches worker subagents and leaves the rest alone", () => {
    expect(["general-purpose", "pstack:effort-high", "pstack:effort-max"].filter(matches)).toHaveLength(3);
    const others = ["Explore", "Plan", "pstack:poteto-agent", "pstack:poteto-agent-high", "pstack:comment-sicko", "my-general-purpose"];
    expect(others.filter(matches)).toEqual([]);
  });

  // Claude Code passes a subagent only hookSpecificOutput.additionalContext;
  // plain stdout lands in the transcript but not in the subagent's context.
  const context = (out) => {
    const { hookSpecificOutput } = JSON.parse(out);
    expect(hookSpecificOutput.hookEventName).toBe("SubagentStart");
    return hookSpecificOutput.additionalContext;
  };

  test("prints the context as SubagentStart JSON", () => {
    const { status, out } = run(subagentHook, '{"agent_type":"general-purpose"}');
    expect(status).toBe(0);
    const template = readFileSync(join(pluginRoot, "hooks/subagent-start-context.md"), "utf8").trimEnd();
    expect(context(out)).toBe(template.replaceAll("<root>", pluginRoot));
  });

  test("names the plugin root once, and each path under it exists", () => {
    const out = context(run(subagentHook, '{"agent_type":"general-purpose"}').out);
    expect(out).not.toContain("<root>");
    const [root, ...paths] = [...out.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(root).toBe(pluginRoot);
    expect(paths.length).toBeGreaterThan(0);
    for (const rel of paths) {
      const found = rel.includes("*") ? [...new Bun.Glob(rel).scanSync({ cwd: pluginRoot })].length > 0 : existsSync(join(pluginRoot, rel));
      expect(`${rel}: ${found}`).toBe(`${rel}: true`);
    }
  });

  test("copies a plugin root holding &, \\, and a quote as is, in valid JSON", () => {
    const parent = mkdtempSync(join(tmpdir(), "pstack-turn-root-"));
    try {
      const root = join(parent, 'a&b\\c"d');
      cpSync(join(pluginRoot, "hooks"), join(root, "hooks"), { recursive: true });
      const { out } = run(subagentHook, "{}", { root });
      expect(context(out)).toContain(`\`${root}\``);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("turn-context.sh", () => {
  test("fails on an unknown event", () => {
    const r = run('"${CLAUDE_PLUGIN_ROOT}/hooks/turn-context.sh" stop', "{}");
    expect(r.status).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err.trim()).toBe("turn-context.sh: unknown event 'stop' (expected prompt or subagent)");
  });

  for (const { name, sheet, off } of sheetCases) {
    test(`sheet ${name}: ${off ? "both events inject nothing" : "both events inject"}`, () => {
      const prompt = run(promptHook, JSON.stringify({ prompt: "x" }), { sheet });
      const subagent = run(subagentHook, "{}", { sheet });
      expect(prompt.out === "").toBe(off);
      expect(subagent.out === "").toBe(off);
    });
  }
});
