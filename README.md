# Agent Hotline

Agent Hotline is a local Windows tray app that reads useful parts of Codex and Claude Code responses aloud.

You keep using Codex or Claude Code as usual. Agent Hotline listens for completed responses through local hooks, removes code-heavy content from the spoken version, and reads the remaining summary with WebView text-to-speech. The full response stays visible in the original chat.

## What It Does

- Reads completed Codex and Claude Code responses aloud.
- Filters out code blocks, diffs, logs, stack traces, tables, JSON, and long dumps by default.
- Lets you save replies for manual playback or auto-play them when idle.
- Includes read, pause, resume, stop, replay, mute, and unmute controls.
- Stores settings locally in `%APPDATA%\Agent Hotline\`.
- Uses local browser/WebView text-to-speech.
- Does not require OpenAI, Anthropic, or speech provider API keys for read-aloud playback.

## Current Status

Stage 1 is complete for local development use.

Included:

- Local backend API.
- Tauri tray app and compact control panel.
- Codex and Claude Code hook commands.
- Speakable-text filtering.
- Persistent settings and speech queue.
- Automated tests, linting, formatting checks, Rust checks, and CI.

Not included yet:

- Packaged installer.
- Bundled backend sidecar for production installs.
- Voice input owned by Agent Hotline.
- Spoken interruption or live conversation bridging.

## Requirements

- Windows 10 or 11.
- Node.js 22 or newer.
- Rust toolchain with `rustfmt` and `clippy`.
- Tauri development prerequisites for Windows.

## Install

```powershell
npm install
```

## Run Locally

Start the backend:

```powershell
npm run dev:backend
```

Start the desktop app in another terminal:

```powershell
npm run dev:desktop
```

Default backend URL:

```text
http://127.0.0.1:4777
```

## Hook Setup

Use the integration guide for the tool you want to read aloud:

- [Codex setup](docs/integrations/codex.md)
- [Claude Code setup](docs/integrations/claude-code.md)

You can smoke test without launching either tool:

```powershell
'{"source":"codex","response":{"text":"Agent Hotline is ready to read this response aloud."}}' | node packages/backend/bin/agent-hotline-hook.js
```

If the backend is running, the response appears in the Agent Hotline queue. If the backend is not running, the hook exits safely.

## Quality Checks

Run the full local gate:

```powershell
npm run check
```

This runs:

- Backend and desktop tests.
- Prettier format check.
- ESLint.
- Rust format check.
- Rust clippy with warnings denied.
- Backend syntax checks.
- Vite build.
- Tauri `cargo check`.

GitHub Actions runs the same check on Windows.

## Useful Commands

```powershell
npm test
npm run lint
npm run format
npm run format:check
npm run check
```

## Docs

- [Docs index](docs/README.md)
- [Manual review script](docs/stage-1-manual-review.md)
- [Codex setup](docs/integrations/codex.md)
- [Claude Code setup](docs/integrations/claude-code.md)

## Repo Layout

```text
docs/                 Human setup and review docs
packages/backend/     Local HTTP API, filtering, queue, settings, hook command
packages/desktop/     Tauri tray shell and WebView control panel
```
