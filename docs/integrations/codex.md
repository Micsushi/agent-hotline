# Codex Read-Aloud Setup

Agent Hotline can read Codex responses aloud by using a Codex `Stop` hook. Codex keeps working normally; the hook runs after a turn finishes, sends the final assistant message to the local Agent Hotline backend, and exits quietly so it does not add noise to the Codex chat.

Agent Hotline TTS does not use the OpenAI API. No `OPENAI_API_KEY` is required for read-aloud playback. The desktop WebView reads queued text with local browser text-to-speech.

## Before You Start

Start Agent Hotline first:

```powershell
cd C:\Users\sushi\Documents\Github\agent-hotline
npm install
npm run dev:backend
npm run dev:desktop
```

The hook command sends text to `http://127.0.0.1:4777` by default. To use a different local backend URL, set `AGENT_HOTLINE_URL`.

You can smoke test the hook command without Codex:

```powershell
'{"source":"codex","response":{"text":"Agent Hotline is ready to read Codex responses aloud."}}' | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

If Agent Hotline is running, this queues the sentence. If Agent Hotline is not running, the hook exits safely.

## Per-Repo Setup

Per-repo setup is recommended. It keeps read-aloud opt-in and makes the hook easy to review.

In the repository where you use Codex, create `.codex/hooks/agent-hotline-stop.ps1`:

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
    source = "codex"
    hook_event_name = "Stop"
    response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js"
} catch {
  exit 0
}

exit 0
```

Then create `.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "commandWindows": "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"$root = git rev-parse --show-toplevel; & (Join-Path $root '.codex/hooks/agent-hotline-stop.ps1')\"",
            "timeout": 5,
            "statusMessage": "Queueing Codex response for Agent Hotline"
          }
        ]
      }
    ]
  }
}
```

Then start or restart Codex in that repository. Codex may ask you to review and trust the hook before it runs. Use `/hooks` in Codex to inspect and trust it.

Why the wrapper exists: Codex `Stop` hooks provide the final text as `last_assistant_message`. The current Agent Hotline hook command expects a normalized Codex-like payload with `source: "codex"` and `response.text`, so the PowerShell wrapper reshapes the hook input before calling:

```powershell
node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

## Global Setup

Codex can also load hooks from the user Codex config directory, such as `%USERPROFILE%\.codex\hooks.json`.

Per-repo setup is still recommended for Agent Hotline until global behavior is verified in your Codex environment. Global hooks can run for every trusted Codex project, which may be surprising if you only want read-aloud in a few repos.

If you choose global setup, put the same `hooks.json` content in:

```text
%USERPROFILE%\.codex\hooks.json
```

For global setup, place the PowerShell wrapper at:

```text
%USERPROFILE%\.codex\hooks\agent-hotline-stop.ps1
```

and use this `commandWindows` value in the global `hooks.json`:

```json
"commandWindows": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.codex\\hooks\\agent-hotline-stop.ps1\""
```

Then review the hook with `/hooks` in Codex.

## Disable Read-Aloud

To disable only this repo, remove the `Stop` hook from:

```text
<repo>\.codex\hooks.json
```

or rename/remove the file. You can also delete `<repo>\.codex\hooks\agent-hotline-stop.ps1` if no hook references it.

To disable a global setup, remove the hook from:

```text
%USERPROFILE%\.codex\hooks.json
```

To disable all Codex hooks in your Codex config, set:

```toml
[features]
hooks = false
```

You can also leave Codex hooks enabled and turn off Codex playback in Agent Hotline settings when the settings UI is available.

## What The Hook Does

When a Codex turn finishes, the hook:

1. Reads the completed Codex hook JSON from stdin.
2. Takes the final assistant message.
3. Calls the Agent Hotline hook command with that text.
4. Agent Hotline filters out code-heavy content, diffs, logs, tables, JSON, and long dumps.
5. If there is useful speakable text, Agent Hotline queues it for local TTS.

The hook does not send text to OpenAI or any speech provider. It only talks to the local Agent Hotline backend.

## Troubleshooting

- No audio: make sure Agent Hotline is running and the desktop app is open.
- Hook runs but nothing is spoken: the response may have been filtered out as code-heavy, or Codex playback may be disabled in Agent Hotline settings.
- Different port: set `AGENT_HOTLINE_URL`, for example `http://127.0.0.1:4888`, before starting Codex.
- Need hook diagnostics: set `AGENT_HOTLINE_HOOK_DEBUG=1` before starting Codex. The hook only writes debug output for skips or recoverable failures.
