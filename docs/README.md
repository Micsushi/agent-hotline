# Agent Hotline Docs

These docs are for people installing, running, or reviewing Agent Hotline.

## Setup

- [Spoken / Displayed output setup](integrations/spoken-output.md)
- [Codex read-aloud setup](integrations/codex.md)
- [Claude Code read-aloud setup](integrations/claude-code.md)
- [Antigravity read-aloud setup](integrations/antigravity.md)

Local development installers:

```powershell
npm run install:tts
npm run install-hotline -- --harness all --skill all
npm run install-hook -- --harness codex --scope repo
npm run install-skill -- --target all
```

`npm install` runs `install:tts` automatically for the desktop workspace. It
copies HeadTTS package files and downloads Kokoro voice packs into the ignored
`packages/desktop/public/headtts/` runtime asset folder.

## Review

- [Stage 1 manual review](stage-1-manual-review.md)

## Notes

Agent Hotline read-aloud does not require model, speech-to-text, or text-to-speech provider API keys. It talks to the local backend and uses browser/WebView text-to-speech for playback.
