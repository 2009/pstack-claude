# Codex on Windows: turn-context.sh's prompt and subagent events without Bash.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prompt', 'subagent')]
    [string]$HookEvent
)
$ErrorActionPreference = 'Stop'

$sheetRoot = $env:CODEX_HOME
if (-not $sheetRoot) {
    $sheetRoot = Join-Path $env:USERPROFILE '.codex'
}
$sheet = Join-Path $sheetRoot 'pstack-models.md'
$off = $false
if (Test-Path -LiteralPath $sheet -PathType Leaf) {
    # An unreadable sheet leaves the hook on, as turn-context.sh does.
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sheet)
        # Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
        $encoding = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [System.Text.Encoding]::Unicode } else { [System.Text.UTF8Encoding]::new($false) }
        $lines = $encoding.GetString($bytes).TrimStart([char]0xFEFF) -split "`n" | ForEach-Object { $_ -replace "`r$", '' }
        $off = $lines -ccontains 'session hook: off'
    } catch { }
}
if ($off) {
    exit 0
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$raw = [Console]::In.ReadToEnd()

if ($HookEvent -eq 'subagent') {
    $root = Split-Path -Parent $PSScriptRoot
    $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'subagent-start-context.md'), $utf8).TrimEnd("`r", "`n").Replace('<root>', $root)
    $output = @{ hookSpecificOutput = @{ hookEventName = 'SubagentStart'; additionalContext = $text } }
    [Console]::Write(($output | ConvertTo-Json -Compress -Depth 3))
    exit 0
}

$hookInput = $null
try { $hookInput = $raw | ConvertFrom-Json } catch { }
if ($null -ne $hookInput) {
    # A prompt Codex sends itself, and a subagent's own prompts, start no new
    # task for the router.
    if (([string]$hookInput.prompt).TrimStart().StartsWith('<') -or $hookInput.agent_type) {
        exit 0
    }
    # Codex names every skill's SKILL.md in each turn's context, so only an
    # injected skill or a tool call naming the file shows poteto-mode opened.
    $transcript = [string]$hookInput.transcript_path
    if ($transcript -and (Test-Path -LiteralPath $transcript -PathType Leaf)) {
        try {
            foreach ($line in [System.IO.File]::ReadLines($transcript)) {
                if ($line.Contains('<name>pstack:poteto-mode</name>') -or
                    ($line.Contains('"type":"function_call"') -and $line -match 'poteto-mode(/|\\+)SKILL\.md')) {
                    exit 0
                }
            }
        } catch { }
    }
}
[Console]::Write([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prompt-reminder.md'), $utf8))
