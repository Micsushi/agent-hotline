# Agent Hotline Desktop

Tauri v2 desktop shell for Agent Hotline.

This package owns:

- Windows tray app lifecycle.
- Tray menu actions.
- Compact WebView control panel.
- Browser text-to-speech playback.
- Read mode and playback controls.
- Settings UI.

Backend state and hook processing live in `packages/backend`.

## Run

Start the backend first:

```powershell
npm run dev:backend
```

Start the desktop app:

```powershell
npm run dev:desktop
```

The WebView uses `AGENT_HOTLINE_URL` when set. Otherwise it targets:

```text
http://127.0.0.1:4777
```

The frontend dev server binds to:

```text
http://127.0.0.1:4778
```

## Tray Menu

- Open Panel
- Read Latest
- Pause/Resume
- Stop
- Replay
- Mute/Unmute
- Settings
- Quit

Closing the WebView hides it so the tray app keeps running. `Quit` exits the app.

## Focus Note

The WebView starts hidden and does not request focus at startup. Showing the panel from the tray may still activate the window because it uses Tauri's normal cross-platform show behavior.

## Checks

```powershell
npm --workspace @agent-hotline/desktop run test
npm --workspace @agent-hotline/desktop run check
```
