$ErrorActionPreference = "Stop"

# Codex `notify` program. Codex passes the event as a single JSON *argument*
# (not stdin) on turn completion. We capture the raw payload for inspection and,
# on agent-turn-complete, forward the assistant text to the Agent Hotline hook.

try {
  if ($args.Count -lt 1) { exit 0 }
  $raw = $args[$args.Count - 1]
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

  # Debug capture: dump the raw notify payload so we can see exactly what Codex
  # sends. Safe no-op if it fails.
  try {
    $dbgDir = "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\data\hook-debug"
    New-Item -ItemType Directory -Force -Path $dbgDir | Out-Null
    Set-Content -Path (Join-Path $dbgDir "codex-raw.json") -Value $raw -Encoding utf8
  } catch {}

  $payload = $raw | ConvertFrom-Json

  # Only act on a completed turn.
  if ($payload.type -and $payload.type -ne "agent-turn-complete") { exit 0 }

  # Field name is hyphenated in Codex notify payloads; tolerate variants.
  $assistantText = $payload.'last-assistant-message'
  if ([string]::IsNullOrWhiteSpace($assistantText)) {
    $assistantText = $payload.last_assistant_message
  }
  if ([string]::IsNullOrWhiteSpace($assistantText)) { exit 0 }

  $threadId = $payload.'thread-id'

  # Codex's own curated chat name: match thread-id to its entry in the session
  # index. Fall back to this turn's first input message, then the latest entry.
  $threadName = $null
  try {
    $idxPath = "C:\Users\sushi\.codex\session_index.jsonl"
    if (Test-Path $idxPath) {
      foreach ($line in [System.IO.File]::ReadLines($idxPath)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $entry = $line | ConvertFrom-Json
        if ($entry.id -eq $threadId) { $threadName = $entry.thread_name }
      }
    }
  } catch {}
  if ([string]::IsNullOrWhiteSpace($threadName)) {
    try { $threadName = ($payload.'input-messages')[0] } catch {}
  }

  @{
    source = "codex"
    hook_event_name = "Stop"
    thread_id = $threadId
    cwd = $payload.cwd
    sessionName = $threadName
    response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js"
} catch {
  exit 0
}

exit 0
