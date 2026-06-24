# Agent Hotline

Agent Hotline is a local Windows tray app that reads useful parts of Codex and Claude Code responses aloud.

You keep using Codex or Claude Code as usual. Agent Hotline listens for completed responses through local hooks, removes code-heavy content from the spoken version, and reads the remaining summary with WebView text-to-speech. The full response stays visible in the original chat.

## What It Does

- Reads completed Codex and Claude Code responses aloud.
- Filters out code blocks, diffs, logs, stack traces, tables, JSON, and long dumps by default.
- Lets you choose manual, automatic, or ask-every-time reading.
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

During install, the desktop workspace runs `install:tts`. That installs the
HeadTTS npm dependency assets into the ignored local folder
`packages/desktop/public/headtts/` and downloads the Kokoro voice packs used by
the timestamped local TTS engine. These files are runtime assets and are not
committed to the repo.

If install scripts were skipped, or if the local TTS assets need repair, run:

```powershell
npm run install:tts
```

Optional TTS asset controls:

```powershell
npm run install:tts -- --voices=af_heart       # install only one voice
npm run install:tts -- --voices=af_heart,am_adam
$env:AGENT_HOTLINE_SKIP_HEADTTS_INSTALL='1'; npm install
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

## Install Hooks And Spoken Skill

Agent Hotline needs two pieces to work well with an agent harness:

1. A hook that sends completed responses to the local Agent Hotline tool.
2. The spoken-output skill or instruction block that makes the agent write a `Spoken:` section.

In local development, install both with:

```powershell
npm run install-hotline -- --harness all --skill all
```

Or run the two pieces separately:

```powershell
npm run install-hook
npm run install-skill -- --target all
```

`install-hook` wires the harness Stop hook. `install-skill` installs the
Antigravity skill file and adds managed `Spoken:` / `Displayed:` instructions for
Codex and Claude Code.

Skip prompts with flags:

```powershell
npm run install-hook -- --harness antigravity
npm run install-hook -- --harness claude-code --scope global
npm run install-hook -- --harness codex --scope repo
npm run install-hook -- --harness all   # global for all three harnesses
npm run install-skill -- --target all
```

The packaged CLI shape is the same command surface:

```powershell
agent-hotline install --harness all --skill all
agent-hotline hook
```

For manual setup, use the integration guide for the harness you want to read aloud:

- [Codex setup](docs/integrations/codex.md)
- [Claude Code setup](docs/integrations/claude-code.md)
- [Antigravity setup](docs/integrations/antigravity.md)

You can smoke test without launching either tool:

```powershell
'{"source":"codex","response":{"text":"Spoken:`nAgent Hotline is ready to read this response aloud.`n`nDisplayed:`nSmoke test complete."}}' | node packages/backend/bin/agent-hotline.js hook
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
