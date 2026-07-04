# macOS Compatibility Notes

Audit date: 2026-07-03

## Status

Partial, inferred from code and docs. The backend/browser path is likely close on macOS once Node is installed. Desktop/Tauri development is likely feasible. Hook installation and release packaging still look Windows-first.

This was audited from Ubuntu, so no native macOS build or runtime smoke was executed.

## What Was Checked

- Static platform scan for `darwin`, app data paths, browser open commands, Tauri scripts, and packaging scripts.
- Existing Linux container backend tests from the Linux audit showed most backend behavior is portable, but some Windows path tests fail off Windows.

## What Should Work On macOS

- Browser backend with Node 22.
- Opening the browser panel: `run-command.js` uses `open` on `darwin`.
- Settings storage: `settings-store.js` uses `~/Library/Application Support/Agent Hotline` on `darwin`.
- Tauri dev command wrappers already choose non-Windows binaries for `tauri` and `vite`.

## Resolved In Code (verified on Linux, inferred for macOS)

The prior blockers are handled by the same cross-platform code paths that were
verified on Linux; they are expected to work on macOS but were not run natively:

- POSIX hook generation: `hook-script.js#buildSh` emits a `.sh` hook on non-Windows,
  so macOS gets a shell hook, not `.ps1`.
- Data path: `platform.js#getDefaultDataDir` uses `~/Library/Application Support/Agent Hotline`
  on `darwin`.
- SEA target: `defaultSeaTargetTriple` returns `x86_64-apple-darwin` / `aarch64-apple-darwin`
  by arch, and `build-backend-sea.mjs` sets the Mach-O segment on `darwin`.
- README now lists macOS support and Tauri macOS prerequisites (Xcode CLT, Rust, Node 22+).

## Remaining (macOS-specific)

- No native macOS run in this audit (audited from Linux).
- macOS desktop release still needs a signing/notarization decision before distribution.
- A macOS CI/package job is not set up yet.

## Suggested macOS Smoke Path

```bash
npm ci
npm --prefix packages/backend test
npm run stage-web
node packages/backend/bin/agent-hotline.js run --browser
```

Desktop smoke, after Rust and Tauri prerequisites:

```bash
npm run dev
```
