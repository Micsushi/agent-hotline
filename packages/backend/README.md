# Agent Hotline Backend

Local HTTP backend for Agent Hotline.

This package owns:

- Hook input parsing.
- Speakable-text filtering.
- Speech queue storage.
- Settings storage.
- Local API endpoints used by the desktop app.
- The `agent-hotline-hook` command used by Codex and Claude Code hooks.

## Run

From the repo root:

```powershell
npm run dev:backend
```

From this package:

```powershell
npm start
```

Default URL:

```text
http://127.0.0.1:4777
```

Override the port with `AGENT_HOTLINE_PORT`.

## Local Data

Runtime settings and speech queue state are stored in:

```text
%APPDATA%\Agent Hotline\
```

Development question queue data, if created by old prototype routes, is local-only and ignored by git.

## Checks

```powershell
npm --prefix packages/backend test
npm --prefix packages/backend run check
```
