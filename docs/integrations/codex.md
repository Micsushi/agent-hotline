# Codex Setup

Agent Hotline can read Codex replies aloud through a Codex `Stop` hook. It only talks to the local Agent Hotline backend.

## Install

Start Agent Hotline first:

```powershell
npm install
npm run dev:backend
npm run dev:desktop
```

Then install the Codex hook and spoken-output instructions:

```powershell
npx --yes agent-hotline install --harness codex --skill codex --scope global
```

From a local checkout:

```powershell
npm run install-hotline -- --harness codex --skill codex --scope global
```

For a different backend URL, set `AGENT_HOTLINE_URL` before starting Codex.

## Test

```powershell
'{"source":"codex","response":{"text":"Spoken:`nAgent Hotline is ready to read Codex aloud.`n`nDisplayed:`nSmoke test complete."}}' | node packages/backend/bin/agent-hotline.js hook
```

If Agent Hotline is running, the sentence lands in the queue. If not, the hook exits quietly.

## Turn It Off

- Repo setup: remove the hook from `<repo>\.codex\hooks.json`.
- Global setup: remove it from `%USERPROFILE%\.codex\hooks.json`.
- Temporary: turn off Codex playback in Agent Hotline settings.

## Troubleshooting

- No audio: make sure the backend and desktop app are running.
- Nothing queued: the reply may have been filtered out, or Codex playback may be off.
- Different port: set `AGENT_HOTLINE_URL`.
- Hook diagnostics: set `AGENT_HOTLINE_HOOK_DEBUG=1` before starting Codex.
