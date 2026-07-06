# macOS Compatibility Notes

Audit date: 2026-07-04

## Status

Backend/browser, hook installation, and the web assets are compatible on macOS.
Desktop/Tauri development checks pass on macOS when Rust is available through
`cargo` or `rustup run stable cargo`.

## What Was Checked

- Native macOS backend tests, desktop tests, formatting, linting, web staging,
  Tauri `cargo clippy`, and Tauri `cargo check`.
- Native macOS backend SEA build and health check with an official Node 22
  runtime via `NODE_SEA_RUNTIME`.
- Native macOS Tauri app/DMG build.
- Static platform scan for `darwin`, app data paths, browser open commands, Tauri scripts, and packaging scripts.
- macOS CI and desktop release workflow wiring.

## What Should Work On macOS

- Browser backend with Node 22.
- Opening the browser panel: `run-command.js` uses `open` on `darwin`.
- Settings storage: `settings-store.js` uses `~/Library/Application Support/Agent Hotline` on `darwin`.
- Tauri dev command wrappers already choose non-Windows binaries for `tauri` and `vite`.

## Resolved In Code

- POSIX hook generation: `hook-script.js#buildSh` emits a `.sh` hook on non-Windows,
  so macOS gets a shell hook, not `.ps1`.
- Data path: `platform.js#getDefaultDataDir` uses `~/Library/Application Support/Agent Hotline`
  on `darwin`.
- SEA target: `defaultSeaTargetTriple` returns `x86_64-apple-darwin` / `aarch64-apple-darwin`
  by arch, and `build-backend-sea.mjs` sets the Mach-O segment on `darwin`.
- README now lists macOS support and Tauri macOS prerequisites (Xcode CLT, Rust, Node 22+).
- Root Rust scripts use `scripts/cargo.mjs`, which preserves normal `cargo`
  behavior and falls back to `rustup run stable cargo` when Homebrew rustup has
  no Cargo shim on PATH.
- `.github/workflows/ci.yml` runs the full `npm run check` gate on both
  `windows-latest` and `macos-latest`.
- `.github/workflows/desktop-release.yml` builds Windows NSIS and macOS DMG
  artifacts without sharing platform-specific installer config.
- macOS SEA output is ad-hoc signed after postject injection so the generated
  backend binary can launch locally and inside the app bundle.

## Remaining (macOS-specific)

- macOS desktop release still needs a signing/notarization decision before distribution.
- Local SEA packaging needs a Node runtime with a postject-compatible SEA fuse.
  GitHub Actions `setup-node` provides one; if a local Node build fails, set
  `NODE_SEA_RUNTIME` to an official Node runtime.

## Suggested macOS Smoke Path

```bash
npm ci
npm run check
node packages/backend/bin/agent-hotline.js run --browser
```

Desktop smoke, after Rust and Tauri prerequisites:

```bash
npm run dev
```

Packaging smoke, using an official Node runtime for SEA:

```bash
NODE_SEA_RUNTIME=/path/to/official/node npm run build:backend-sea
npm --workspace @agent-hotline/desktop run tauri -- build --config src-tauri/tauri.installer.macos.conf.json
```
