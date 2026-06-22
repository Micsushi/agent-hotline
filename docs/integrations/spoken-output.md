# Spoken / Displayed Output Setup

Agent Hotline reads your agent's responses aloud. By default it strips code-heavy
content and reads a short version of the prose. You get a much better read-aloud
experience if the agent writes a dedicated **Spoken** section.

When a response contains a `Spoken:` section, Agent Hotline reads only that section
and ignores the rest. Your chat still shows the entire response, code and all. The
`Displayed:` section is for everything that should stay on screen but never be read.

This is always-on output formatting, so it belongs in your agent's persistent
instructions, not in an on-demand skill (an invoked skill would not fire on every
turn).

## The Contract

Paste this block into your agent instructions (locations below):

```text
Agent Hotline read-aloud: structure every response in two labeled sections.

Spoken:
A short, conversational summary meant to be heard, not read. 2 to 6 sentences.
No code, file paths, commands, or symbols. One idea at a time. At most one
question. Plain spoken English.

Displayed:
Your full normal answer: code, commands, file paths, diffs, steps, and detail.

Always include both sections. The user sees both in chat. Only the Spoken
section is read aloud, so it must stand on its own without the Displayed part.
```

## Claude Code

Add the contract to a `CLAUDE.md` the agent always loads:

- Per project: append it to `CLAUDE.md` in the repo root.
- Global: append it to `%USERPROFILE%\.claude\CLAUDE.md`.

This applies in both the Claude Code CLI and the Claude Code VSCode extension,
because the extension loads the same `CLAUDE.md` and the same `.claude` hooks.

## Codex

Add the contract to the `AGENTS.md` Codex reads:

- Per project: append it to `AGENTS.md` in the repo root.
- Global: append it to `%USERPROFILE%\.codex\AGENTS.md`.

## Capture Across CLI and VSCode Extensions

Read-aloud capture uses the `Stop` hook described in
[claude-code.md](claude-code.md) and [codex.md](codex.md).

- Claude Code CLI and VSCode extension share `.claude/settings.json`, so one Stop
  hook covers both.
- Codex CLI reads `.codex/hooks.json`. Confirm the Codex VSCode extension runs the
  same hook with `/hooks` inside the extension. If the extension does not fire the
  Stop hook, read-aloud will only work from the Codex CLI until a hook-capable
  path is available.

## Verify

1. Start Agent Hotline (`npm run dev:backend`, `npm run dev:desktop`).
2. Install the Stop hook for your client and the contract above.
3. Ask the agent anything. It should answer with `Spoken:` and `Displayed:`.
4. Agent Hotline should read only the Spoken text. The full answer stays in chat.

If the Spoken section is missing, Agent Hotline falls back to reading a trimmed
version of the prose, so read-aloud still works without the contract.
