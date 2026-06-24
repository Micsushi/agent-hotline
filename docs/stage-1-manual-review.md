# Stage 1 Manual Review: Windows Read-Aloud

Use this script to review Stage 1 end to end on Windows. Record the result for each checklist item as Pass, Fail, or Blocked. If a step fails, record the step id, what you expected, what happened, any visible error text, and whether the backend, desktop app, Codex, or Claude Code was running.

Stage 1 must not require `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or any speech provider API key. Codex and Claude Code still use their own normal login or subscription for real chats, but the Agent Hotline read-aloud layer only talks to the local backend and the desktop WebView.

## Review Environment

- Windows 10 or 11.
- Node.js installed.
- Rust and the Tauri prerequisites installed if you are launching the desktop app from source.
- Speakers or headphones available.
- Repository path: `C:\Users\sushi\Documents\Github\agent-hotline`.
- Default backend URL: `http://127.0.0.1:4777`.

Before starting, close any old Agent Hotline backend or desktop processes. If you want a clean queue/settings state, move these files aside:

```powershell
Move-Item "$env:APPDATA\Agent Hotline\settings.json" "$env:APPDATA\Agent Hotline\settings.review-backup.json" -ErrorAction SilentlyContinue
Move-Item "$env:APPDATA\Agent Hotline\speech-queue.json" "$env:APPDATA\Agent Hotline\speech-queue.review-backup.json" -ErrorAction SilentlyContinue
```

## Start Agent Hotline

1. Open PowerShell in the repo.

```powershell
cd C:\Users\sushi\Documents\Github\agent-hotline
npm install
```

Expected result: dependencies install without requiring provider API keys.

2. Start the backend in one PowerShell window.

```powershell
npm run dev:backend
```

Expected result: the backend reports that Agent Hotline is listening on `http://127.0.0.1:4777`.

3. In a second PowerShell window, start the desktop app.

```powershell
cd C:\Users\sushi\Documents\Github\agent-hotline
npm run dev:desktop
```

Expected result: the Tauri desktop app starts, a tray icon is present, and opening the panel shows Agent Hotline connected to the backend.

4. Check backend health.

```powershell
Invoke-RestMethod http://127.0.0.1:4777/api/health
```

Expected result: JSON with `ok: true` and `service: agent-hotline`.

## Hook Smoke Tests

These tests do not require Codex, Claude Code, OpenAI API keys, Anthropic API keys, or speech provider keys.

### HR-01 Codex Hook Smoke

Run:

```powershell
'{"source":"codex","response":{"text":"Agent Hotline is ready to read Codex responses aloud."}}' | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: the command exits without noisy output. In the Agent Hotline panel, a Codex item is queued or read according to the current read behavior.

Record on failure: command exit code, stderr text if `AGENT_HOTLINE_HOOK_DEBUG=1` is set, and whether the backend was running.

### HR-02 Claude Hook Smoke

Run:

```powershell
'{"source":"claude","assistant_response":{"text":"Agent Hotline is ready to read Claude Code responses aloud."}}' | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: the command exits without noisy output. In the Agent Hotline panel, a Claude item is queued or read according to the current read behavior.

Record on failure: command exit code, stderr text if `AGENT_HOTLINE_HOOK_DEBUG=1` is set, and whether the backend was running.

### HR-03 Backend Down Safe Exit

Stop the backend, then run either hook smoke command again.

Expected result: the hook exits safely with exit code `0` and does not print normal stdout. Codex or Claude Code would be allowed to continue.

Optional diagnostic run:

```powershell
$env:AGENT_HOTLINE_HOOK_DEBUG = "1"
'{"source":"codex","response":{"text":"Backend down should not break the agent session."}}' | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
Remove-Item Env:\AGENT_HOTLINE_HOOK_DEBUG
```

Expected diagnostic result: stderr may mention a recoverable backend failure. Exit code remains `0`.

Restart the backend before continuing.

## Settings Checks

Use the Agent Hotline panel unless a step says to use PowerShell.

### SR-01 Save-Only Mode

1. Set Queue behavior to Save only.
2. Confirm Mute is off.
3. Run the Codex hook smoke command.

Expected result: the item appears as pending and is not read until the reviewer presses Read.

### SR-02 Auto-Play Mode

1. Set Queue behavior to Auto-play.
2. Run the Codex or Claude hook smoke command.

Expected result: the next queued item starts reading automatically when nothing else is playing.

### SR-03 Mute

1. Turn Mute on.
2. Run a hook smoke command.
3. Turn Mute off.

Expected result: while muted, no new speech starts and the preview remains visible. After unmuting, normal read behavior resumes for later items.

### SR-04 Codex Enabled Toggle

1. Turn Codex off in settings.
2. Run the Codex hook smoke command.
3. Turn Codex on again.
4. Run the Codex hook smoke command again.

Expected result: when Codex is disabled, Codex hook output is not queued or spoken. After re-enabling, Codex output queues or reads normally.

### SR-05 Claude Enabled Toggle

1. Turn Claude off in settings.
2. Run the Claude hook smoke command.
3. Turn Claude on again.
4. Run the Claude hook smoke command again.

Expected result: when Claude is disabled, Claude hook output is not queued or spoken. After re-enabling, Claude output queues or reads normally.

### SR-06 Voice, Rate, And Volume

1. Choose a non-default voice if another voice is available.
2. Set rate noticeably below default, then read a short item.
3. Set rate noticeably above default, then read a short item.
4. Set volume low, then read a short item.
5. Restore comfortable rate and volume.

Expected result: voice selection is applied when available, rate changes speech speed, and volume changes playback loudness. Settings survive closing and reopening the desktop app.

PowerShell settings sanity check:

```powershell
Invoke-RestMethod http://127.0.0.1:4777/api/settings
```

Expected result: JSON shows the selected `readBehavior`, `mute`, `voice`, `rate`, `volume`, `codexEnabled`, and `claudeEnabled` values.

## Playback Controls

Use short test text for read/replay and longer text for pause/resume/stop.

Queue a long item:

```powershell
'{"source":"codex","response":{"text":"This is a longer manual review sample. Agent Hotline should read this sentence, then keep going long enough for pause, resume, stop, replay, mute, and unmute checks to be observable by a human reviewer. The exact voice can vary by Windows installation."}}' | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

### PR-01 Read

Expected result: pressing Read starts speaking the pending speakable text and updates the panel status to speaking.

### PR-02 Pause

Expected result: pressing Pause stops speech progression and updates status to paused.

### PR-03 Resume

Expected result: pressing Resume continues the paused speech.

### PR-04 Stop

Expected result: pressing Stop ends current speech and leaves the app responsive.

### PR-05 Replay

Expected result: pressing Replay queues and reads the latest replayable speakable response.

### PR-06 Mute And Unmute

Expected result: pressing Mute during playback stops or prevents speech. Pressing Unmute allows later read actions to speak again.

### PR-07 Tray Controls

Use the tray menu for Read Latest, Pause/Resume, Stop, Replay, Mute/Unmute, Settings, Open Panel, and Quit.

Expected result: tray actions mirror panel behavior where applicable. Quit closes the desktop app cleanly.

## Filtering Checks

For each sample, run the command and inspect the panel preview plus audio. Expected result for every filtering check: code, diffs, logs, tables, JSON, and long dumps are not read aloud by default. If Agent Hotline speaks anything, it should be short prose rather than the structured block.

### FR-01 Code Block

````powershell
@'
{"source":"codex","response":{"text":"Here is the fix:\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nThe important part is that the helper now returns the sum."}}
'@ | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
````

Expected result: the JavaScript code is not read. A short explanation may be read.

### FR-02 Diff

````powershell
@'
{"source":"codex","response":{"text":"```diff\n- old value\n+ new value\n```\n\nThis changes the stored value."}}
'@ | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
````

Expected result: diff lines are not read aloud.

### FR-03 Logs

```powershell
@'
{"source":"claude","assistant_response":{"text":"The test failed:\n\nError: expected 200 got 500\n    at Object.<anonymous> (server.test.js:12:3)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n\nThe likely issue is the error path."}}
'@ | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: stack/log lines are not read aloud.

### FR-04 Table

```powershell
@'
{"source":"claude","assistant_response":{"text":"| File | Status |\n| --- | --- |\n| a.ts | pass |\n| b.ts | fail |\n\nOne file still needs attention."}}
'@ | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: table contents are not read aloud.

### FR-05 JSON

```powershell
@'
{"source":"codex","response":{"text":"{\n  \"status\": \"ok\",\n  \"items\": [1, 2, 3]\n}\n\nThe JSON payload is valid."}}
'@ | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: JSON keys and braces are not read aloud.

### FR-06 Long Dump

```powershell
@'
{"source":"codex","response":{"text":"Files found:\n- one.txt\n- two.txt\n- three.txt\n- four.txt\n- five.txt\n- six.txt\n- seven.txt\n- eight.txt\n- nine.txt\n- ten.txt\n\nThere are many files, so the spoken summary should stay short."}}
'@ | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: the long list is skipped or reduced to short prose.

## Real Codex And Claude Code Chat Checks

These checks verify the real hook path. They require normal Codex or Claude Code access, but still do not require provider API keys for Agent Hotline TTS.

### RR-01 Codex Normal Chat

1. Follow `docs/integrations/codex.md` for per-repo setup.
2. Start or restart Codex in the test repo.
3. Review and trust the hook with `/hooks` if Codex asks.
4. Ask Codex a short normal question, such as: `Give me one sentence I can use to test Agent Hotline read-aloud.`

Expected result: Codex displays its normal chat response. Agent Hotline receives the completed response through the Stop hook, filters it, and queues or reads the useful spoken part based on settings. Codex chat remains usable.

### RR-02 Claude Code Normal Chat

1. Follow `docs/integrations/claude-code.md` for per-repo setup.
2. Start or restart Claude Code in the test repo.
3. Ask Claude Code a short normal question, such as: `Give me one sentence I can use to test Agent Hotline read-aloud.`

Expected result: Claude Code displays its normal chat response. Agent Hotline receives the completed response through the Stop hook, filters it, and queues or reads the useful spoken part based on settings. Claude Code remains usable.

## Failure Review

### FF-01 No Provider API Keys

In a fresh PowerShell window, do not set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, or `AZURE_SPEECH_KEY`. Start backend and desktop, then run the hook smoke tests.

Expected result: local read-aloud still works.

### FF-02 Malformed Hook Input

```powershell
'{not valid json' | node C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js
```

Expected result: exit code `0`, no noisy stdout, no backend crash, and no item queued.

### FF-03 Disabled Source Is Safe

Disable Codex or Claude in settings, then run that source's hook smoke command.

Expected result: hook exits safely, does not queue speech, and the agent session would not be interrupted.

## What To Record For Failures

For every failed or blocked item, record:

- Step id.
- Pass, Fail, or Blocked.
- Exact command or UI action used.
- Expected result.
- Actual result.
- Backend console output if relevant.
- Desktop visible error or status text if relevant.
- Whether the item appeared in `Invoke-RestMethod http://127.0.0.1:4777/api/queue`.
- Whether settings from `Invoke-RestMethod http://127.0.0.1:4777/api/settings` matched the test setup.
- Whether the failure reproduces after restarting backend and desktop.
