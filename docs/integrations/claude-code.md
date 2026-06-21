# Claude Code Read-Aloud Hook Setup

Use this guide to let Claude Code send completed assistant responses to Agent Hotline for local read-aloud.

Agent Hotline does not call the Anthropic API for read-aloud. You do not need to set `ANTHROPIC_API_KEY` for Agent Hotline text-to-speech. Claude Code still uses its own normal authentication for Claude sessions.

## What The Hook Does

The hook runs after Claude Code finishes a response. Claude Code passes the hook a JSON payload on stdin. The wrapper below reads Claude Code's `last_assistant_message`, passes it to the Agent Hotline hook command, and the hook command filters out code-heavy content such as code blocks, diffs, logs, tables, and JSON dumps. It then posts the speakable text to the local Agent Hotline backend at `http://127.0.0.1:4777`.

If Agent Hotline is not running, the hook exits successfully and quietly. It should not break or interrupt your Claude Code session.

## Before You Start

Start Agent Hotline locally:

```powershell
cd C:\Users\sushi\Documents\Github\agent-hotline
npm install
npm run dev:backend
npm run dev:desktop
```

The Agent Hotline hook command path is:

```powershell
node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

If your backend is not using the default URL, set `AGENT_HOTLINE_URL` in the environment that starts Claude Code:

```powershell
$env:AGENT_HOTLINE_URL = "http://127.0.0.1:4777"
claude
```

## Per-Repo Setup

Per-repo local setup is recommended first because it is easy to test and does not affect your other Claude Code projects.

From the repository where you run Claude Code, create `.claude/hooks/agent-hotline-stop.ps1`:

```powershell
$ErrorActionPreference = "Stop"

try {
  $inputJson = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($inputJson)) {
    exit 0
  }

  $payload = $inputJson | ConvertFrom-Json
  $assistantText = $payload.last_assistant_message
  if ([string]::IsNullOrWhiteSpace($assistantText)) {
    exit 0
  }

  @{
    source = "claude"
    hook_event_name = "Stop"
    assistant_response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js"
} catch {
  exit 0
}

exit 0
```

Then create or edit `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-hotline-stop.ps1"
            ],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Then run Claude Code normally in that repository. After Claude finishes a response, Agent Hotline should queue the speakable part for read-aloud.

If the repository already has Claude Code hooks, merge the `Stop` entry into the existing `hooks` object instead of replacing the file.

Use `.claude/settings.json` instead of `.claude/settings.local.json` only when you intentionally want to share this hook with everyone who uses the repository. For shared settings, every user must have Agent Hotline available at the same command path or adjust the path for their machine.

## Global Setup

Claude Code supports user-level settings in `%USERPROFILE%\.claude\settings.json` on Windows. Use global setup if you want Agent Hotline read-aloud in every Claude Code project.

Create `%USERPROFILE%\.claude\hooks\agent-hotline-stop.ps1`:

```powershell
$ErrorActionPreference = "Stop"

try {
  $inputJson = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($inputJson)) {
    exit 0
  }

  $payload = $inputJson | ConvertFrom-Json
  $assistantText = $payload.last_assistant_message
  if ([string]::IsNullOrWhiteSpace($assistantText)) {
    exit 0
  }

  @{
    source = "claude"
    hook_event_name = "Stop"
    assistant_response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js"
} catch {
  exit 0
}

exit 0
```

Then add this hook to `%USERPROFILE%\.claude\settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              "C:\\Users\\sushi\\.claude\\hooks\\agent-hotline-stop.ps1"
            ],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Per-repo setup is still the safer first step. Verify the hook in one project before moving it into global settings.

## Disable The Hook

To disable Agent Hotline for one repository, remove the `Stop` hook entry from `.claude/settings.local.json` or `.claude/settings.json`. You can also delete `.claude/hooks/agent-hotline-stop.ps1` if no settings file references it.

To disable all Claude Code hooks in that settings file temporarily, add:

```json
{
  "disableAllHooks": true
}
```

If your settings file already has other keys, add `disableAllHooks` beside them instead of replacing the whole file.

To disable read-aloud without changing Claude Code settings, stop Agent Hotline or turn off Claude playback in Agent Hotline settings when the settings UI is available.

## Troubleshooting

- No audio: make sure `npm run dev:backend` and `npm run dev:desktop` are running.
- Hook path errors: run `node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js` from PowerShell to confirm Node can find the file.
- Wrapper path errors: make sure `.claude/settings.local.json` points at the PowerShell wrapper file you created.
- Custom backend URL: start Claude Code from a shell where `AGENT_HOTLINE_URL` points at your backend.
- Debugging: set `AGENT_HOTLINE_HOOK_DEBUG=1` before starting Claude Code. The hook will write short skip or recoverable-failure reasons to stderr without printing normal stdout.
