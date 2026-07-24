---
name: agent-hotline-spoken
description: >
  Opt-in Agent Hotline read-aloud formatting. Never activate automatically.
  Activate only when the user says "hotline on", "read aloud on",
  "start read-aloud", or "spoken mode" in the current thread.
---

# Agent Hotline Spoken Skill

Every new thread starts with read-aloud off. Never activate automatically from
hook presence, backend state, installed-skill discovery, another thread, or a
previous conversation. Activation requires an explicit enable phrase in the
current thread and remains scoped to that thread only.

When the read-aloud skill is active, final user-facing assistant replies must
include a `Spoken:` section. `Displayed:` is required when exact technical
material must remain visible; otherwise omit it.

Do not apply this format to hidden reasoning, tool calls, tool output, or
internal progress. Short progress updates may stay plain when the final answer
will carry the read-aloud format.

For visible interim progress updates, use the user's normal terse caveman-style
agent communication: short, direct, and no filler. Do not add a `Spoken:`
section just to narrate tool use.

```text
Spoken:
<the smallest useful spoken answer for this conversational chunk>

==========

Displayed:
<exact technical or dense visual support, when needed>
```

## Spoken Section

`Spoken` is the primary answer. It must stand on its own for the conclusion,
status, recommendation, risks, and next action.

Write the smallest useful spoken answer, not the shortest possible answer.

Include:

- the actual conclusion, status, or recommendation
- names for options, approaches, or things being compared
- the key reason when it changes the decision
- important caveats or risks
- the next step, if there is one
- when it is present, tell the listener what exact material is in `Displayed`
  and why they may need to look at it

Avoid:

- vague references like "option one", "this", "that approach", or "the above"
- exhaustive evidence or step-by-step reasoning unless the user asked for it
- repeating details that belong in `Displayed`
- code, commands, file paths, diffs, logs, tables, or markdown
- explaining every implementation detail when the listener only needs the
  outcome and the reason

## Displayed Section

`Displayed` is required when the answer needs exact code, commands, file paths,
diffs, logs, tables, diagrams, class or method references, error text, or other
material that must not be paraphrased. Do not drop required technical material
just to keep the response spoken-only.

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

Do not chunk or defer urgent, time-sensitive, or safety-critical steps. If the
user explicitly asks for a complete answer, complete response, or all details in
one reply, provide them now. Keep `Spoken` focused on the immediate action and
tell the listener that the complete exact detail is in `Displayed`.

## Required Format

- `Spoken:` sits alone on its own line.
- `==========` sits alone on its own line when `Displayed` is present.
- `Displayed:` sits alone on its own line when used.
- While read-aloud mode is active, final user-facing assistant replies must
  include `Spoken:`.

Agent Hotline reads only the `Spoken:` section. The `Displayed:` section stays
visible in the chat and is never spoken.
