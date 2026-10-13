import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
const handler = JSON.parse(readFileSync(join(pluginRoot, manifest.hooks), "utf8")).hooks.SessionStart[0].hooks[0];
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");

function runHook({ sheet, codexHome, homeSheet, context = mandate, host = "cmd" } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "pstack windows hook "));
  try {
    const plugin = join(fixture, "plugin with spaces");
    const profile = join(fixture, "user profile");
    const sheetRoot = codexHome ? join(fixture, "codex home") : join(profile, ".codex");
    cpSync(join(pluginRoot, "hooks"), join(plugin, "hooks"), { recursive: true });
    for (const [dir, content] of [[join(profile, ".codex"), homeSheet], [sheetRoot, sheet]]) {
      if (content !== undefined) {
        mkdirSync(dir, { recursive: true });
        writeSheet(join(dir, "pstack-models.md"), content);
      }
    }
    const contextPath = join(plugin, "hooks/session-start-context.md");
    if (context === null) rmSync(contextPath);
    else writeFileSync(contextPath, context);
    const command = handler.commandWindows.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin);
    const env = {
      SystemRoot: process.env.SystemRoot,
      PATH: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
      PATHEXT: process.env.PATHEXT,
      USERPROFILE: profile,
      HOME: join(fixture, "other home"),
      CLAUDE_PLUGIN_ROOT: plugin,
      PSExecutionPolicyPreference: "Restricted",
    };
    for (const name of ["TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "ProgramData", "PSModulePath"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    if (codexHome !== undefined) env.CODEX_HOME = codexHome ? sheetRoot : "";
    const executable = host === "cmd" ? process.env.ComSpec ?? "cmd.exe" : "powershell.exe";
    const args = host === "cmd" ? ["/d", "/s", "/c", command] : ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
    const result = spawnSync(executable, args, {
      env,
      encoding: "utf8",
      windowsVerbatimArguments: host === "cmd",
    });
    if (result.error) throw result.error;
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

// CI's Windows job sets this, so a platform check that misfires fails there
// instead of skipping every test.
const required = process.env.PSTACK_REQUIRE_WINDOWS_HOOK === "1";

describe.skipIf(process.platform !== "win32" && !required)("Windows Codex SessionStart hook", () => {
  test("injects the shared context without a sheet or Bash", () => {
    expect(runHook()).toEqual({ status: 0, out: mandate, err: "" });
    const result = runHook({ host: "powershell" });
    expect({ ...result, out: result.out.replaceAll("\r\n", "\n") }).toEqual({ status: 0, out: mandate.replaceAll("\r\n", "\n"), err: "" });
  });

  test("reads USERPROFILE when CODEX_HOME is absent or empty", () => {
    for (const codexHome of [undefined, false]) {
      expect(runHook({ codexHome, sheet: "session hook: off\n" })).toEqual({ status: 0, out: "", err: "" });
    }
  });

  test("CODEX_HOME takes precedence over USERPROFILE", () => {
    expect(runHook({ codexHome: true, sheet: "session hook: off\r\n", homeSheet: "session hook: on\n" })).toEqual({
      status: 0, out: "", err: "",
    });
    expect(runHook({ codexHome: true, sheet: "session hook: on\n", homeSheet: "session hook: off\n" })).toEqual({
      status: 0, out: mandate, err: "",
    });
  });

  for (const { name, sheet, off } of sheetCases) {
    test(`${off ? "injects nothing" : "injects the context"} when the sheet has ${name}`, () => {
      expect(runHook({ sheet })).toEqual({ status: 0, out: off ? "" : mandate, err: "" });
    });
  }

  test("writes UTF-8 context without an added newline", () => {
    const context = "Routing context: 中文 café 🚀";
    expect(runHook({ context })).toEqual({ status: 0, out: context, err: "" });
  });

  test("fails when the context cannot be read", () => {
    const result = runHook({ context: null });
    expect(result.status).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  });
});

// turn-context.ps1, Codex's UserPromptSubmit and SubagentStart commands on
// Windows (#264). On Windows they run through the shipped commandWindows under
// Windows PowerShell 5.1; elsewhere through pwsh when PSTACK_PWSH names it.
const turnHooks = JSON.parse(readFileSync(join(pluginRoot, manifest.hooks), "utf8")).hooks;
const turnHandlers = { prompt: turnHooks.UserPromptSubmit[0].hooks[0], subagent: turnHooks.SubagentStart[0].hooks[0] };
const reminder = readFileSync(join(pluginRoot, "hooks/prompt-reminder.md"), "utf8");
const subagentTemplate = readFileSync(join(pluginRoot, "hooks/subagent-start-context.md"), "utf8").trimEnd();
const pwsh = process.platform === "win32" ? null : process.env.PSTACK_PWSH;

function runTurn(event, input, { sheet, transcript } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "pstack windows turn "));
  try {
    const plugin = join(fixture, "plugin with spaces & more");
    const profile = join(fixture, "user profile");
    cpSync(join(pluginRoot, "hooks"), join(plugin, "hooks"), { recursive: true });
    if (sheet !== undefined) {
      mkdirSync(join(profile, ".codex"), { recursive: true });
      writeSheet(join(profile, ".codex", "pstack-models.md"), sheet);
    }
    let stdin = input;
    if (transcript !== undefined) {
      const path = join(fixture, "rollout.jsonl");
      writeFileSync(path, transcript.map((line) => `${line}\n`).join(""));
      stdin = JSON.stringify({ ...JSON.parse(input), transcript_path: path });
    }
    const env = { PATH: process.env.PATH, USERPROFILE: profile, HOME: join(fixture, "other home"), CLAUDE_PLUGIN_ROOT: plugin };
    let result;
    if (process.platform === "win32") {
      for (const name of ["SystemRoot", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "ProgramData", "PSModulePath"]) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      env.PATH = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0");
      env.PSExecutionPolicyPreference = "Restricted";
      const command = turnHandlers[event].commandWindows.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin);
      result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
        env, input: stdin, encoding: "utf8", windowsVerbatimArguments: true,
      });
    } else {
      result = spawnSync(pwsh, ["-NoProfile", "-File", join(plugin, "hooks/turn-context.ps1"), event], { env, input: stdin, encoding: "utf8" });
    }
    if (result.error) throw result.error;
    return { status: result.status, out: result.stdout, err: result.stderr, plugin };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32" ? !pwsh : false)("Windows Codex turn hooks", () => {
  const listing = JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "- pstack:poteto-mode: style. (file: r1/poteto-mode/SKILL.md)" }] } });
  const call = (cmd) => JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } });
  const prompt = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fix the login bug" });
  const quiet = (r) => ({ status: r.status, out: r.out, err: r.err });

  test("the reminder runs while poteto-mode is unopened, the skills listing included", () => {
    expect(quiet(runTurn("prompt", prompt))).toEqual({ status: 0, out: reminder, err: "" });
    expect(runTurn("prompt", prompt, { transcript: [listing] }).out).toBe(reminder);
  });

  for (const [how, line] of [
    ["an injected skill", JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>pstack:poteto-mode</name>" }] } })],
    ["a tool call that reads its file", call("cat /p/skills/poteto-mode/SKILL.md")],
    ["a tool call with a Windows path", call("Get-Content C:\\p\\skills\\poteto-mode\\SKILL.md")],
  ]) {
    test(`the reminder stops once poteto-mode is opened by ${how}`, () => {
      expect(quiet(runTurn("prompt", prompt, { transcript: [listing, line] }))).toEqual({ status: 0, out: "", err: "" });
    });
  }

  test("the reminder stays quiet inside a subagent and on a prompt Codex sends itself", () => {
    expect(runTurn("prompt", JSON.stringify({ prompt: "x", agent_type: "default" })).out).toBe("");
    expect(runTurn("prompt", JSON.stringify({ prompt: " <subagent_notification>{}</subagent_notification>" })).out).toBe("");
  });

  test("the reminder runs on input that is not JSON", () => {
    expect(runTurn("prompt", "{").out).toBe(reminder);
  });

  test("the subagent context is SubagentStart JSON naming the plugin root", () => {
    const { status, out, err, plugin } = runTurn("subagent", '{"agent_type":"default"}');
    expect({ status, err }).toEqual({ status: 0, err: "" });
    const { hookSpecificOutput } = JSON.parse(out);
    expect(hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(hookSpecificOutput.additionalContext).toBe(subagentTemplate.replaceAll("<root>", plugin));
  });

  for (const { name, sheet, off } of sheetCases) {
    test(`sheet ${name}: ${off ? "both events inject nothing" : "both events inject"}`, () => {
      expect(runTurn("prompt", prompt, { sheet }).out === "").toBe(off);
      expect(runTurn("subagent", "{}", { sheet }).out === "").toBe(off);
    });
  }
});
