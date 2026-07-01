# Claude Code Setup

Agent Hotline can read Claude Code replies aloud through a `Stop` hook. It only talks to the local Agent Hotline backend.

## Install

Start Agent Hotline first:

```powershell
npm install
npm run dev
```

Then install the Claude Code hook and spoken-output instructions:

```powershell
npx --yes @micsushi/agent-hotline install --harness claude-code --skill claude-code --scope global
```

From a local checkout:

```powershell
npm run install-hotline -- --harness claude-code --skill claude-code --scope global
```

For a different backend URL, set `AGENT_HOTLINE_URL` before starting Claude Code.

## Test

```powershell
'{"source":"claude","assistant_response":{"text":"Spoken:`nAgent Hotline is ready to read Claude Code aloud.`n`nDisplayed:`nSmoke test complete."}}' | node packages/backend/bin/agent-hotline.js hook
```

If Agent Hotline is running, the sentence lands in the queue. If not, the hook exits quietly.

## Turn It Off

- Repo setup: remove the hook from `.claude/settings.local.json`.
- Global setup: remove it from `%USERPROFILE%\.claude\settings.json`.
- Temporary: turn off Claude playback in Agent Hotline settings.

## Troubleshooting

- No audio: restart the full app with `npm run restart`.
- Nothing queued: the reply may have been filtered out, or Claude playback may be off.
- Different port: set `AGENT_HOTLINE_URL`.
- Hook diagnostics: set `AGENT_HOTLINE_HOOK_DEBUG=1` before starting Claude Code.
