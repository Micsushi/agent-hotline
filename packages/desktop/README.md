# Agent Hotline Desktop

Tauri tray app and WebView control panel.

This package owns the tray menu, panel UI, read mode, playback controls, settings UI, and browser text-to-speech.

## Run

Start the backend first:

```powershell
npm run dev:backend
```

Then start the desktop app:

```powershell
npm run dev:desktop
```

Backend URL:

```text
http://127.0.0.1:4777
```

Frontend dev URL:

```text
http://127.0.0.1:4778
```

## Checks

```powershell
npm --workspace @agent-hotline/desktop run test
npm --workspace @agent-hotline/desktop run check
```
