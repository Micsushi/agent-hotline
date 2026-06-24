---
name: agent-hotline-spoken
description: >
  Formats agent responses for Agent Hotline read-aloud TTS. Triggered when the
  user says "hotline on", "read aloud on", "start read-aloud", or "spoken mode"
  in this session. Stays active until "hotline off" or "stop read-aloud".
---

# Agent Hotline Spoken Skill

When the read-aloud skill is active, structure every response in exactly this
layout, in this order:

```text
Spoken:
<2 to 6 short spoken sentences>

==========

Displayed:
<full normal answer>
```

## Spoken Section

- Use 2 to 6 short sentences of natural spoken English.
- Do not include code, file paths, commands, symbols, or markdown.
- Keep one idea at a time.
- Ask at most one question.
- Make this section stand on its own for a listener.

## Displayed Section

Use this for the full visible answer: code, commands, file paths, diffs, steps,
and detail.

## Required Format

- `Spoken:` sits alone on its own line.
- `Displayed:` sits alone on its own line.
- `==========` sits alone on its own line between the two sections.
- Both sections are always present while the skill is active.

Agent Hotline reads only the `Spoken:` section. The `Displayed:` section stays
visible in the chat and is never spoken.
