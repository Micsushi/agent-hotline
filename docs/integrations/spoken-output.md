# Spoken Output

Agent Hotline reads the `Spoken:` section and ignores `Displayed:`. Use
`Spoken:` for the real conversational answer. `Displayed:` is required when
exact technical material must remain visible; otherwise omit it.

Install the spoken-output skill:

```powershell
npm run install-skill -- --target all
```

From npm:

```powershell
agent-hotline install-skill --target all
```

## Contract

```text
Spoken:
The smallest useful spoken answer for this conversational chunk.

==========

Displayed:
Exact code, paths, commands, diffs, logs, tables, diagrams, or dense details.
```

`Spoken:` must stand on its own for someone listening without looking at the
screen. It should name the actual recommendation, status, option, caveat, and
next step when those matter. Avoid vague references like "option one" or "this
approach" unless the spoken text also explains what they mean.

Do not overfill `Spoken:` with evidence, implementation minutiae, code, paths,
commands, diffs, logs, or tables. Put those in `Displayed:` when they are useful.
When `Displayed:` is present, `Spoken:` must tell the listener what exact
material is shown and why they may need to look at it. Do not duplicate the
spoken answer in `Displayed:`.

For broad answers, keep the whole reply to one conversational chunk. Answer the
most useful slice, briefly name what can be continued next, and let the user ask
for the next slice. Do not create a multi-screen `Displayed:` section that the
`Spoken:` section cannot cover.

Do not chunk or defer urgent, time-sensitive, or safety-critical steps. If the
user explicitly asks for a complete answer, complete response, or all details in
one reply, provide them now. Put complete exact material in `Displayed:` and
summarize the immediate action in `Spoken:`.

`Displayed:` can be omitted when no exact technical or dense visual material is
needed.

## Examples

Simple status:

```text
Spoken:
Yes, Hotline mode is on. The old instruction text is still installed, so it may
keep pushing spoken replies shorter than you want.
```

Code-heavy answer:

````text
Spoken:
I would update the installer-generated instruction block first, because that is
what future Codex and Claude installs reuse. The source skill and docs should
match it, and the test should prevent the old fixed sentence limit from coming
back. The exact assertions are shown in Displayed.

==========

Displayed:
```js
assert.doesNotMatch(text, /2 to 6 short sentences/);
assert.match(text, /Displayed is required/);
```
````

Broad answer that should be chunked:

```text
Spoken:
There are three useful chunks here: the instruction contract, the backend parser
behavior, and the live installed copies. I would handle the instruction contract
first, because it controls future installs and most of the bad output shape.
After that, I can walk through parser behavior next.
```

Urgent answer that must not be deferred:

```text
Spoken:
Stop the rollout now and restore the last known-good release. The exact rollback
command and verification checks are shown in Displayed; run them in order.

==========

Displayed:
<exact rollback command and every required verification check>
```

## Verify

1. Start Agent Hotline.
2. Install the hook and spoken-output instructions.
3. Ask for a normal reply.
4. Confirm Agent Hotline reads only the `Spoken:` text.
5. Confirm simple answers do not need `Displayed:`, while code and dense details stay visible only.
6. Ask a broad question and confirm the answer is chunked instead of dumping multiple screens into `Displayed:`.
7. Ask for urgent recovery or a complete answer and confirm no required steps are deferred.
