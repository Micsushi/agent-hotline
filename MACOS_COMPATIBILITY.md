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

## macOS Blockers

- Hook installer is still PowerShell-oriented and generates `.ps1` hooks.
- Some runtime stores still use Windows-like or inconsistent paths, as noted in the Linux audit.
- Backend SEA packaging defaults to `x86_64-pc-windows-msvc`; `postject` has a macOS branch, but the target triple is not selected automatically.
- README is Windows-first and mostly PowerShell examples.
- macOS desktop release would need signing/notarization decisions before distribution.
- Current desktop release CI is Windows-only.

## Likely Changes Needed

- Add POSIX hook script generation usable on macOS and Linux.
- Use macOS data paths consistently:
  - `~/Library/Application Support/Agent Hotline`
  - optionally `~/Library/Caches/Agent Hotline` for cache data
- Make `SEA_TARGET_TRIPLE` platform-aware, e.g. `x86_64-apple-darwin` or `aarch64-apple-darwin`.
- Document Tauri macOS prerequisites:
  - Xcode Command Line Tools
  - Rust
  - Node 22+
- Add release docs for app signing/notarization, or mark local-only unsigned builds as expected.
- Add a macOS CI/package job once packaging is intended.

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
