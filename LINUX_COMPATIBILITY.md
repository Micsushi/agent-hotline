# Linux Compatibility Notes

Audit date: 2026-07-03

## Status

Working on Linux for the backend, browser panel, hooks, and desktop compile. The
full quality gate and a runtime hook smoke both pass in a Linux container. Only the
GUI tray window and audio playback (need a display + audio device) and a prebuilt
Linux installer remain unverified/absent.

## What Was Tested (2026-07-04)

Container with Node 22 + Rust (WebKitGTK deps installed):

- `npm run check` — **passed, exit 0**. This covers:
  - backend + desktop unit tests (all passing)
  - `prettier --check` and `cargo fmt --check`
  - `eslint` and `cargo clippy --all-targets -- -D warnings`
  - backend `node --check` on every source file
  - desktop `vite build` + `cargo check` (Tauri shell compiles on Linux)
- Runtime hook smoke:
  - started the backend (`agent-hotline run --no-open`), hit `/api/health`
  - piped a `hotline on` + Spoken payload through the hook
  - confirmed the item enqueued with the correct speakable text via `/api/queue`

The Windows-path tests flagged in the prior audit now pass off-Windows; the store
and doctor code was made platform-aware.

## What Should Work On Linux

- Backend HTTP API and browser panel should be viable with Node 22.
- Queue, settings, hook parsing, CORS, and localhost API tests mostly pass in a Linux container.
- Browser opening already has an `xdg-open` path.

## Resolved

The functional blockers from the prior audit are handled in code and verified:

- POSIX hook generation: `hook-script.js` emits a `.sh` script (`buildSh`) and picks
  the extension by platform; PowerShell is Windows-only.
- Storage paths: `platform.js#getDefaultDataDir` uses XDG (`$XDG_CONFIG_HOME`/`~/.config`)
  on Linux, `AppData` on Windows, `~/Library/Application Support` on macOS.
- SEA target: `defaultSeaTargetTriple` derives the triple from `process.platform`/`arch`
  (Linux x64/arm64 included).
- README now documents Linux support, Ubuntu Tauri prerequisites, and bash smoke examples.

## Remaining

- No prebuilt Linux desktop installer (build from source with `npm run dev`).
- GUI tray window and audio playback not exercised headlessly (need a display + audio device).

## Ubuntu Smoke Path (verified)

```bash
npm ci --ignore-scripts
npm run check            # tests + lint + fmt + clippy + desktop cargo check
npm run stage-web
node packages/backend/bin/agent-hotline.js run --no-open   # then pipe a hook payload
```

Full desktop launch (`npm run dev`) additionally needs Rust, the Tauri system
packages, and a graphical session.
