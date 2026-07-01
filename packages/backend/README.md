# Agent Hotline Backend

Local HTTP backend for Agent Hotline.

This package owns hook parsing, text filtering, the speech queue, settings, local API routes, and the `agent-hotline hook` command.

## Run

Background mode:

```powershell
ah run
```

Dev mode:

```powershell
npm run dev
```

Default URL:

```text
http://127.0.0.1:4777
```

Use `AGENT_HOTLINE_PORT` to change the port.

Runtime data lives in:

```text
%APPDATA%\Agent Hotline\
```

## Checks

```powershell
npm --prefix packages/backend test
npm --prefix packages/backend run check
```
