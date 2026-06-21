# Backend Response Fixtures

These fixtures are shared examples for backend hook parser and speakable-filter tests.

- `response-fixtures.json` is valid JSON and can be loaded directly by automated tests.
- `malformed-hook-input.txt` is intentionally invalid JSON for hook parser failure tests.

The Codex-like and Claude-like payloads are representative because hook schemas can change. Tests should treat `rawText` as the canonical assistant response text for each case, and use `codexLike` or `claudeLike` to exercise shape detection.
