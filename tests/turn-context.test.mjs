// The UserPromptSubmit and SubagentStart commands each runtime ships, run for
// real (#264): the prompt reminder stops once poteto-mode is open, the
// subagent context names the plugin's own paths, and each runtime's sheet off
// switch silences both.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills } from "../tools/generate.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

// Without a trailing slash, as both runtimes pass CLAUDE_PLUGIN_ROOT.
const pluginRoot = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const read = (rel) => readFileSync(join(pluginRoot, rel), "utf8");
const reminder = read("hooks/prompt-reminder.md");
const mandate = read("hooks/session-start-context.md");
const codexHooks = JSON.parse(read(".codex-plugin/plugin.json")).hooks;

const runtimes = Object.fromEntries(
  [
    ["claude", "hooks/hooks.json", ".claude"],
    ["codex", codexHooks, ".codex"],
  ].map(([name, file, sheetDir]) => {
    const { hooks } = JSON.parse(read(file));
    const [promptGroup] = hooks.UserPromptSubmit;
    const [subagentGroup] = hooks.SubagentStart;
    return [
      name,
      { sheetDir, prompt: promptGroup.hooks[0], subagent: subagentGroup.hooks[0], matcher: new RegExp(subagentGroup.matcher) },
    ];
  }),
);

function run(command, input, { sheet = null, sheetDir = ".claude", root = pluginRoot } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pstack-turn-"));
  try {
    if (sheet !== null) {
      mkdirSync(join(home, sheetDir));
      writeSheet(join(home, sheetDir, "pstack-models.md"), sheet);
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

// A transcript holding `lines`, and the hook input that points at it.
const withTranscript = (lines, fields = {}) => (home) => {
  const path = join(home, "transcript.jsonl");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fix the login bug", transcript_path: path, ...fields });
};

// Claude Code passes a subagent only hookSpecificOutput.additionalContext;
// plain stdout lands in the transcript but not in the subagent's context.
const context = (out) => {
  const { hookSpecificOutput } = JSON.parse(out);
  expect(hookSpecificOutput.hookEventName).toBe("SubagentStart");
  return hookSpecificOutput.additionalContext;
};

test("the reminder names only skills that exist", () => {
  const named = [...reminder.matchAll(/pstack:([a-z0-9-]+)/g)].map((m) => m[1]);
  const skills = new Set(agentSkills(join(pluginRoot, "skills")).map(({ name }) => name));
  expect(named).toEqual(["poteto-mode"]);
  expect(named.filter((name) => !skills.has(name))).toEqual([]);
});

for (const [name, { sheetDir, prompt, subagent }] of Object.entries(runtimes)) {
  const promptHook = prompt.command;
  const subagentHook = subagent.command;

  describe(`${name} UserPromptSubmit reminder`, () => {
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

    test("decodes an escaped transcript path", () => {
      const input = (home) => {
        const dir = join(home, 'quote"and\\slash');
        mkdirSync(dir);
        const path = join(dir, "t.jsonl");
        writeFileSync(path, '{"type":"user","content":"<skill>\\n<name>pstack:poteto-mode</name>"}\n{"type":"tool_use","name":"Skill","input":{"skill":"pstack:poteto-mode"}}\n');
        return JSON.stringify({ prompt: "x", transcript_path: path });
      };
      expect(run(promptHook, input).out).toBe("");
    });

    test("reminds on input that is not one JSON object", () => {
      expect(run(promptHook, '{"prompt": "x"').out).toBe(reminder);
      expect(run(promptHook, "").out).toBe(reminder);
    });

    test("stays quiet on a prompt the runtime sends itself, after leading whitespace too", () => {
      expect(run(promptHook, withTranscript([], { prompt: "<task-notification>done</task-notification>" })).out).toBe("");
      expect(run(promptHook, withTranscript([], { prompt: "\n  <subagent_notification>{}</subagent_notification>" })).out).toBe("");
    });

    for (const { name: sheetName, sheet, off } of sheetCases) {
      test(`sheet ${sheetName}: ${off ? "both events inject nothing" : "both events inject"}`, () => {
        const promptRun = run(promptHook, JSON.stringify({ prompt: "x" }), { sheet, sheetDir });
        const subagentRun = run(subagentHook, "{}", { sheet, sheetDir });
        expect(promptRun.out === "").toBe(off);
        expect(subagentRun.out === "").toBe(off);
      });
    }

    test("reads only its own runtime's sheet", () => {
      const other = sheetDir === ".claude" ? ".codex" : ".claude";
      expect(run(promptHook, JSON.stringify({ prompt: "x" }), { sheet: "session hook: off\n", sheetDir: other }).out).toBe(reminder);
    });
  });

  describe(`${name} SubagentStart context`, () => {
    test("prints the context as SubagentStart JSON", () => {
      const { status, out } = run(subagentHook, '{"agent_type":"general-purpose"}');
      expect(status).toBe(0);
      const template = read("hooks/subagent-start-context.md").trimEnd();
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
}

describe("Claude Code specifics", () => {
  const { prompt, matcher } = runtimes.claude;

  for (const [how, line] of [
    ["the Skill tool", '{"type":"tool_use","name":"Skill","input":{"skill":"pstack:poteto-mode"}}'],
    ["the slash command", '{"type":"user","message":{"content":"<command-name>/pstack:poteto-mode</command-name>"}}'],
    ["a read of its file", '{"type":"tool_use","name":"Read","input":{"file_path":"/p/skills/poteto-mode/SKILL.md"}}'],
  ]) {
    test(`the reminder stops once poteto-mode is opened by ${how}`, () => {
      expect(run(prompt.command, withTranscript([line]))).toEqual({ status: 0, out: "", err: "" });
    });
  }

  test("the subagent context reaches worker subagents and leaves the rest alone", () => {
    expect(["general-purpose", "pstack:effort-high", "pstack:effort-max"].filter((t) => matcher.test(t))).toHaveLength(3);
    const others = ["Explore", "Plan", "pstack:poteto-agent", "pstack:poteto-agent-high", "pstack:comment-sicko", "my-general-purpose"];
    expect(others.filter((t) => matcher.test(t))).toEqual([]);
  });
});

describe("Codex specifics", () => {
  const { prompt, subagent, matcher } = runtimes.codex;
  // Codex's skills listing, as 0.162.1 sends it every turn: it names
  // poteto-mode's SKILL.md without the skill having been opened.
  const listing = JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "- pstack:poteto-mode: poteto's agent style. (file: r1/poteto-mode/SKILL.md)" }] },
  });
  const call = (cmd) =>
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } });

  test("the skills listing alone does not count as poteto-mode opened", () => {
    expect(run(prompt.command, withTranscript([listing])).out).toBe(reminder);
  });

  for (const [how, line] of [
    ["an injected skill", JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>pstack:poteto-mode</name>\n<path>/p/poteto-mode/SKILL.md</path>" }] } })],
    ["a tool call that reads its file", call("sed -n 1,200p /p/skills/poteto-mode/SKILL.md")],
    ["a tool call with a Windows path", call("Get-Content C:\\p\\skills\\poteto-mode\\SKILL.md")],
  ]) {
    test(`the reminder stops once poteto-mode is opened by ${how}`, () => {
      expect(run(prompt.command, withTranscript([listing, line]))).toEqual({ status: 0, out: "", err: "" });
    });
  }

  // Codex fires UserPromptSubmit inside a spawn_agent subagent too, with its
  // agent_type; that subagent gets the SubagentStart context instead.
  test("the reminder stays quiet inside a subagent", () => {
    expect(run(prompt.command, withTranscript([listing], { agent_type: "default" })).out).toBe("");
  });

  test("the subagent context reaches default and worker subagents, not explorer", () => {
    expect(["default", "worker"].filter((t) => matcher.test(t))).toHaveLength(2);
    expect(["explorer", "my-default", "default-reviewer"].filter((t) => matcher.test(t))).toEqual([]);
  });

  test("both hooks carry a PowerShell command for Windows", () => {
    for (const [hook, event] of [[prompt, "prompt"], [subagent, "subagent"]]) {
      expect(hook.commandWindows).toBe(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\${CLAUDE_PLUGIN_ROOT}/hooks/turn-context.ps1" ${event}`,
      );
    }
  });
});

describe("turn-context.sh", () => {
  for (const args of ["stop", "claude stop", "cursor prompt", ""]) {
    test(`fails on arguments ${JSON.stringify(args)}`, () => {
      const r = run(`"\${CLAUDE_PLUGIN_ROOT}/hooks/turn-context.sh" ${args}`, "{}");
      expect(r.status).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err.trim()).toStartWith("turn-context.sh: expected <claude|codex> <prompt|subagent>");
    });
  }
});
