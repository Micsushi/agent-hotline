# Antigravity Read-Aloud Hook Setup

Use this guide to let Antigravity (the Google DeepMind Antigravity agent) send completed responses to Agent Hotline for local read-aloud.

Agent Hotline does not call any external API for read-aloud. You do not need additional API keys for TTS. The desktop WebView reads queued text with local browser text-to-speech.

## What The Hook Does

The hook runs after Antigravity finishes a response. Antigravity passes the hook a JSON payload on stdin. The wrapper below reads `last_assistant_message`, reshapes it into the Agent Hotline payload format with `source: "antigravity"`, and pipes it to the Agent Hotline hook command. The hook filters out code-heavy content and posts the speakable text to the local backend at `http://127.0.0.1:4777`.

If Agent Hotline is not running, the hook exits successfully and quietly. It does not interrupt your Antigravity session.

## Before You Start

Start Agent Hotline locally:

```powershell
cd <path-to-agent-hotline>
npm install
npm run dev:backend
npm run dev:desktop
```

Then install both the Antigravity hook and the spoken skill:

```powershell
npm run install-hotline -- --harness antigravity --skill antigravity
```

The installer writes a hook command using your clone's local path. It will look like:

```powershell
node "<path-to-agent-hotline>\packages\backend\bin\agent-hotline.js" hook
```

If your backend is not using the default URL, set `AGENT_HOTLINE_URL` before starting Antigravity:

```powershell
$env:AGENT_HOTLINE_URL = "http://127.0.0.1:4777"
```

## Global Setup

The Antigravity hooks config lives at `%USERPROFILE%\.gemini\config\hooks.json`. The hook is global and applies to all Antigravity sessions.

The hook wrapper is already installed at:

```text
%USERPROFILE%\.gemini\config\hooks\agent-hotline-stop.ps1
```

And the hook config is already installed at:

```text
%USERPROFILE%\.gemini\config\hooks.json
```

If you need to reinstall or update, the `hooks.json` content is:

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
              "<home>\\.gemini\\config\\hooks\\agent-hotline-stop.ps1"
            ],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

And `agent-hotline-stop.ps1`:

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
    source           = "antigravity"
    hook_event_name  = "Stop"
    assistant_response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "<path-to-agent-hotline>\packages\backend\bin\agent-hotline.js" hook
} catch {
  exit 0
}

exit 0
```

## Activating Read-Aloud

Antigravity uses the `agent-hotline-spoken` skill to format responses for TTS. The skill is auto-discovered from:

```text
%USERPROFILE%\.gemini\config\skills\agent-hotline-spoken\SKILL.md
```

To activate read-aloud in an Antigravity session, say:

```
hotline on
```

or: `read aloud on` / `start read-aloud` / `spoken mode`

To deactivate:

```
hotline off
```

or: `stop read-aloud`

When active, every Antigravity response will have a `Spoken:` section (read aloud) and a `Displayed:` section (visible in chat only). Responses without a `Spoken:` section are skipped by the hook silently, so the hook being wired does not interfere with normal sessions.

## Smoke Test

With Agent Hotline running, test the full path without starting an Antigravity session:

```powershell
@{
  source           = "antigravity"
  hook_event_name  = "Stop"
  assistant_response = @{
    text = "Spoken:`nAgent Hotline is ready to read Antigravity responses aloud.`n`nDisplayed:`nSmoke test complete."
  }
} | ConvertTo-Json -Depth 8 | node "<path-to-agent-hotline>\packages\backend\bin\agent-hotline.js" hook
```

If Agent Hotline is running, the spoken sentence should appear in the queue.

## Session Labeling

Antigravity responses appear in Agent Hotline history labeled as **Antigravity**, not as Claude or Codex. Sessions are grouped by project (the working directory) and each session is labeled by the harness that produced it, so a project can have Claude Code sessions, Codex sessions, and Antigravity sessions interleaved in its history.

## Disable The Hook

To disable Antigravity read-aloud, remove the `Stop` hook entry from:

```text
%USERPROFILE%\.gemini\config\hooks.json
```

Or turn off Antigravity playback in Agent Hotline settings when the settings UI is available (the `antigravityEnabled` toggle).

To stop read-aloud without changing the hook, tell Antigravity:

```
hotline off
```

This deactivates the skill so responses no longer include a `Spoken:` section and the hook skips them silently.

## Troubleshooting

- No audio: make sure `npm run dev:backend` and `npm run dev:desktop` are running.
- Hook path errors: run `node "<path-to-agent-hotline>\packages\backend\bin\agent-hotline.js" hook` from PowerShell to confirm Node can find the file.
- Nothing queued: confirm the Antigravity session has the read-aloud skill active (say "hotline on").
- Custom backend URL: set `AGENT_HOTLINE_URL` before starting Antigravity.
- Debugging: set `AGENT_HOTLINE_HOOK_DEBUG=1`. The hook writes skip or failure reasons to stderr without affecting stdout.
