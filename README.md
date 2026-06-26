# Agent Hotline

Agent Hotline is a local Windows tray app that reads useful parts of Codex, Claude Code, and Antigravity replies aloud.

You keep using your coding tool like normal. Agent Hotline listens for finished responses through local hooks, skips code-heavy bits, and reads the useful prose through the desktop WebView. The full reply stays in the original chat.

## What It Does

- Reads finished coding-agent replies aloud.
- Skips code blocks, diffs, logs, JSON, tables, and big dumps.
- Lets you save replies or auto-play them when idle.
- Gives you read, pause, resume, stop, replay, mute, and unmute controls.
- Stores settings under `%APPDATA%\Agent Hotline\`.
- Does not need model API keys or paid speech APIs for read-aloud.

## Status

Good enough for local development use.

Still missing:

- A normal packaged installer.
- A bundled backend sidecar for production installs.
- Voice input owned by Agent Hotline.

## Requirements

- Windows 10 or 11.
- Node.js 22 or newer.
- For terminal install only: no repo clone is needed.
- For desktop app development: Rust plus the usual Tauri Windows prerequisites.

## Install

### Terminal install from npm

Use this on a normal machine that should not clone this repo:

```powershell
npx --yes @micsushi/agent-hotline install --harness all --skill all
```

That one command downloads the Agent Hotline npm package and installs both parts:

- the hook/tool command used by Codex, Claude Code, and Antigravity
- the spoken-output skill or managed instructions

Start the local backend:

```powershell
npx --yes @micsushi/agent-hotline run
```

For one repo only:

```powershell
npx --yes @micsushi/agent-hotline install --harness all --skill all --scope repo --repo C:\path\to\repo
```

Optional: install once globally so you can use shorter commands:

```powershell
npm install -g @micsushi/agent-hotline
agent-hotline install --harness all --skill all
agent-hotline run
```

Useful separate commands:

```powershell
npx --yes @micsushi/agent-hotline install-hooks --harness all
npx --yes @micsushi/agent-hotline install-skill --target all
npx --yes @micsushi/agent-hotline hook
```

### Local checkout install

Use this only when developing Agent Hotline from this repo:

```powershell
npm install
npm run install-hotline -- --harness all --skill all
```

`npm install` also grabs the local TTS assets used by the desktop app. To repair those assets:

```powershell
npm run install:tts
```

## What Gets Installed

The npm package includes the CLI/backend hook tool and the spoken skill/instructions. Users do not download those separately.

The polished desktop installer is not finished yet. Until then, the desktop control panel is run from a local checkout.

## Run Locally

From a global install, start the backend:

```powershell
ah run
```

From `npx`, start the backend:

```powershell
npx --yes @micsushi/agent-hotline run
```

From a local checkout, run it in the foreground while developing:

```powershell
npm run dev:backend
```

Start the desktop app:

```powershell
npm run dev:desktop
```

Backend URL:

```text
http://127.0.0.1:4777
```

## Smoke Test

With the backend running, test the npm-installed hook:

```powershell
'{"source":"codex","response":{"text":"Spoken:`nAgent Hotline is ready to read this aloud.`n`nDisplayed:`nSmoke test complete."}}' | npx --yes @micsushi/agent-hotline hook
```

From a local checkout, test the local hook:

```powershell
'{"source":"codex","response":{"text":"Spoken:`nAgent Hotline is ready to read this aloud.`n`nDisplayed:`nSmoke test complete."}}' | node packages/backend/bin/agent-hotline.js hook
```

The sentence should show up in the Agent Hotline queue. If the backend is not running, the hook exits quietly.

## Checks

```powershell
npm test
npm run lint
npm run format:check
npm run check
```

## Docs

- [Docs index](docs/README.md)
- [Codex setup](docs/integrations/codex.md)
- [Claude Code setup](docs/integrations/claude-code.md)
- [Antigravity setup](docs/integrations/antigravity.md)

## Repo Layout

```text
docs/                 Human setup notes
packages/backend/     Local API, queue, settings, hook command
packages/desktop/     Tauri tray app and control panel
```
