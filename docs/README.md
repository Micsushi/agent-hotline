# Agent Hotline Docs

Short setup notes for people using or hacking on Agent Hotline.

## Setup

- [Codex](integrations/codex.md)
- [Claude Code](integrations/claude-code.md)
- [Antigravity](integrations/antigravity.md)
- [Spoken output](integrations/spoken-output.md)

## Common Commands

```powershell
npm run install:tts
npm run install-hotline -- --harness all --skill all
npm run dev:backend
npm run dev:desktop
```

From npm:

```powershell
npx --yes agent-hotline install --harness all --skill all
npx --yes agent-hotline hook
```

## Notes

Read-aloud playback is local. Agent Hotline talks to its local backend and uses browser/WebView text-to-speech.
