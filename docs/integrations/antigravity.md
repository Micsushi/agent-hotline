# Antigravity Setup

Agent Hotline can read Antigravity replies aloud through its global hook setup. It only talks to the local Agent Hotline backend.

## Install

Start Agent Hotline first:

```powershell
npm install
npm run dev
```

Install the Antigravity hook and spoken skill:

```powershell
npm run install-hotline -- --harness antigravity --skill antigravity
```

For a different backend URL, set `AGENT_HOTLINE_URL` before starting Antigravity.

## Use It

In Antigravity, say:

```text
hotline on
```

To stop adding read-aloud sections:

```text
hotline off
```

## Test

```powershell
@{
  source = "antigravity"
  hook_event_name = "Stop"
  assistant_response = @{
    text = "Spoken:`nAgent Hotline is ready to read Antigravity aloud.`n`nDisplayed:`nSmoke test complete."
  }
} | ConvertTo-Json -Depth 8 | node packages/backend/bin/agent-hotline.js hook
```

If Agent Hotline is running, the sentence lands in the queue.

## Turn It Off

- Remove the `Stop` hook from `%USERPROFILE%\.gemini\config\hooks.json`.
- Or say `hotline off` in the session.
- Or turn off Antigravity playback in Agent Hotline settings.

## Troubleshooting

- No audio: restart the full app with `npm run restart`.
- Nothing queued: say `hotline on` and try again.
- Different port: set `AGENT_HOTLINE_URL`.
- Hook diagnostics: set `AGENT_HOTLINE_HOOK_DEBUG=1`.
