---
name: agent-hotline-spoken
description: >
  Formats agent responses for Agent Hotline read-aloud TTS. Triggered when the
  user says "hotline on", "read aloud on", "start read-aloud", or "spoken mode"
  in this session. Stays active until "hotline off" or "stop read-aloud".
---

# Agent Hotline Spoken Skill

When the read-aloud skill is active, every response must include a `Spoken:`
section. Add `Displayed:` only when there is visual or dense supporting material
that should stay on screen instead of being read aloud.

```text
Spoken:
<the smallest useful spoken answer for this conversational chunk>

==========

Displayed:
<optional visual-only support>
```

## Spoken Section

`Spoken` is the primary answer. It must stand on its own for someone listening
without looking at the screen.

Write the smallest useful spoken answer, not the shortest possible answer.

Include:

- the actual conclusion, status, or recommendation
- names for options, approaches, or things being compared
- the key reason when it changes the decision
- important caveats or risks
- the next step, if there is one

Avoid:

- vague references like "option one", "this", "that approach", or "the above"
- exhaustive evidence or step-by-step reasoning unless the user asked for it
- repeating details that belong in `Displayed`
- code, commands, file paths, diffs, logs, tables, or markdown
- explaining every implementation detail when the listener only needs the
  outcome and the reason

## Displayed Section

`Displayed` is optional. Use it only for material that is better read than heard:
code, commands, file paths, diffs, logs, tables, diagrams, exact class or method
references, or dense supporting detail.

Do not restate the spoken answer in full. The listener reads `Spoken` first, so
`Displayed` should add visual detail rather than duplicate the answer.

If there is nothing visual or dense to show, omit `Displayed`.

## Chunking

Keep the whole response compact enough for a real conversation.

When the full answer would become long:

- answer the most useful current slice in `Spoken`
- briefly name what remains
- wait for the user to ask to continue

For broad topics, prefer a short spoken map of the next chunks over a long
displayed dump. A listener should never need to read multiple screens of
`Displayed` to understand what `Spoken` was talking about.

## Required Format

- `Spoken:` sits alone on its own line.
- `==========` sits alone on its own line when `Displayed` is present.
- `Displayed:` sits alone on its own line when used.
- While read-aloud mode is active, every response must include `Spoken:`.

Agent Hotline reads only the `Spoken:` section. The `Displayed:` section stays
visible in the chat and is never spoken.
