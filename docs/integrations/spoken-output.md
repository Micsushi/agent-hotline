# Spoken Output

Agent Hotline works best when a reply has a short `Spoken:` section. It reads that part and ignores the rest.

Install the formatting instructions:

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
A short, conversational summary meant to be heard.

==========

Displayed:
The full normal answer with code, paths, commands, and details.
```

Keep `Spoken:` short and plain. Put everything technical in `Displayed:`.

## Verify

1. Start Agent Hotline.
2. Install the hook and spoken-output instructions.
3. Ask for a normal reply.
4. Confirm Agent Hotline reads only the `Spoken:` text.
