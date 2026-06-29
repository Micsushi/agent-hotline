# Agent Hotline

Agent Hotline is a local Windows tray app that reads useful parts of Codex, Claude Code, and Antigravity replies aloud.

You keep using your coding tool like normal. Agent Hotline listens for finished responses through local hooks, skips code-heavy bits, and reads the useful prose through the browser or desktop UI. The full reply stays in the original chat.

## What It Does

- Reads finished coding-agent replies aloud.
- Skips code blocks, diffs, logs, JSON, tables, and big dumps.
- Lets you save replies or auto-play them when idle.
- Gives you read, pause, resume, stop, replay, mute, and unmute controls.
- Stores settings under `%APPDATA%\Agent Hotline\`.
- Does not need model API keys or paid speech APIs for read-aloud.

## Status

Usable from npm or the Windows desktop installer.

Still missing:

- Voice input owned by Agent Hotline.

## Requirements

- Windows 10 or 11.
- Node.js 22 or newer for the npm/npx commands.
- No repo clone is needed for normal install.
- For desktop app development: Rust plus the usual Tauri Windows prerequisites.

## Install

### Recommended: desktop app plus hook setup

1. Download and run the latest Windows installer:

```text
https://github.com/Micsushi/agent-hotline/releases/latest
```

2. Install the hooks and spoken instructions:

```powershell
npx --yes @micsushi/agent-hotline install --harness all --skill all
```

3. Restart Codex, Claude Code, or Antigravity so it reloads its hook files.

After that, open Agent Hotline from the Start Menu. The desktop app starts its own bundled backend and opens the panel. No separate `ah run` command is needed for the desktop installer.

### Terminal install from npm

Use this when you want the browser control panel instead of the native tray app:

```powershell
npx --yes @micsushi/agent-hotline install --harness all --skill all
npx --yes @micsushi/agent-hotline run
```

The install command downloads the Agent Hotline npm package and installs both parts:

- the hook/tool command used by Codex, Claude Code, and Antigravity
- the spoken-output skill or managed instructions

The run command starts the backend and opens the browser control panel:

```text
http://127.0.0.1:4777
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

If `ah` or `agent-hotline` is not found after a global install, run:

```powershell
npx --yes @micsushi/agent-hotline doctor
npx --yes @micsushi/agent-hotline doctor --fix-path
```

Useful separate commands:

```powershell
npx --yes @micsushi/agent-hotline install-hooks --harness all
npx --yes @micsushi/agent-hotline install-skill --target all
npx --yes @micsushi/agent-hotline hook
npx --yes @micsushi/agent-hotline run --no-open
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

The npm package includes the CLI/backend hook tool, the browser control panel, and the spoken skill/instructions. Users do not download those separately.

The GitHub release includes the Windows desktop installer for the native tray/WebView app and a bundled backend. The installer does not yet write Codex, Claude Code, or Antigravity hook files, so run the npm setup command once after installing the desktop app.

## Run Locally

From a global install, start the backend:

```powershell
ah run
```

From `npx`, start the backend:

```powershell
npx --yes @micsushi/agent-hotline run
```

This also opens the browser control panel:

```text
http://127.0.0.1:4777
```

To start only the backend:

```powershell
npx --yes @micsushi/agent-hotline run --no-open
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

## Troubleshooting

### The desktop app says Backend unavailable

Install the latest GitHub release. The current desktop app starts its bundled backend automatically. If you are using the npm/browser version instead, run:

```powershell
npx --yes @micsushi/agent-hotline run
```

### I ran ah run but no tray icon appeared

`ah run` starts the npm/browser version. It opens `http://127.0.0.1:4777` and does not start the native tray app. For the tray app, install and launch the GitHub `.exe`.

### ah is not recognized

Use `npx` directly, or install globally:

```powershell
npm install -g @micsushi/agent-hotline
npx --yes @micsushi/agent-hotline doctor
```

If npm's global command folder is missing from PATH on Windows:

```powershell
npx --yes @micsushi/agent-hotline doctor --fix-path
```

Restart the terminal after changing PATH.

### Agent replies are not spoken

Make sure the hook and spoken instructions are installed, then restart the coding tool:

```powershell
npx --yes @micsushi/agent-hotline install --harness all --skill all
```

Then say `hotline on` or `read aloud on` in Codex, Claude Code, or Antigravity.

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
