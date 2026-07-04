# Linux Compatibility Notes

Audit date: 2026-07-03

## Status

Partial. The browser/backend path is close to working on Ubuntu once Node is available, but the hook installer and desktop packaging are still Windows-first.

## What Was Tested

- Host scan: Node, npm, Rust, and Cargo are not installed on this Ubuntu machine.
- Disposable Docker test:
  - `npm ci --ignore-scripts`
  - `npm --prefix packages/backend test`
- Result: backend tests ran in a Linux Node 22 container, with 80 passing, 3 failing, 1 skipped.

The failures were Windows-path expectation tests running on Linux:

- `packages/backend/test/doctor.test.js`
- `packages/backend/test/settings-store.test.js`

## What Should Work On Linux

- Backend HTTP API and browser panel should be viable with Node 22.
- Queue, settings, hook parsing, CORS, and localhost API tests mostly pass in a Linux container.
- Browser opening already has an `xdg-open` path.

## Linux Blockers

- Hook installation writes PowerShell-based `.ps1` hooks and `powershell.exe` / `cmd.exe` commands.
- Runtime storage paths are inconsistent across Linux:
  - some code uses XDG config
  - some code falls back to Windows-like `AppData/Roaming`
  - some code uses `~/.agent-hotline`
- Desktop packaging defaults are Windows-oriented, including the SEA backend target.
- README examples are mostly PowerShell and Windows installer oriented.

## Likely Changes Needed

- Add a POSIX hook script generator, for example `agent-hotline-stop.sh`.
- Select PowerShell vs shell hook commands by platform.
- Normalize Linux runtime state to XDG paths:
  - config: `${XDG_CONFIG_HOME:-~/.config}/agent-hotline`
  - data/state/cache: `${XDG_DATA_HOME:-~/.local/share}/agent-hotline`
- Make backend SEA target default from `process.platform` and `process.arch`.
- Add Ubuntu README instructions for Node 22, Rust/Tauri prerequisites, browser mode, and local hook smoke tests.

## Suggested Ubuntu Smoke Path

```bash
npm ci
npm --prefix packages/backend test
npm run stage-web
node packages/backend/bin/agent-hotline.js run --browser
```

Desktop/Tauri smoke still needs Rust and Linux Tauri system packages.
