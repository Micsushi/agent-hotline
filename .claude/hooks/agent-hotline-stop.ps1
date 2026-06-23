$ErrorActionPreference = "Stop"

try {
  $inputJson = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($inputJson)) {
    exit 0
  }

  # Debug capture: dump the raw hook payload so we can see exactly what Claude
  # sends (used to derive a session name). Safe no-op if it fails.
  try {
    $dbgDir = "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\data\hook-debug"
    New-Item -ItemType Directory -Force -Path $dbgDir | Out-Null
    Set-Content -Path (Join-Path $dbgDir "claude-raw.json") -Value $inputJson -Encoding utf8
  } catch {}

  $payload = $inputJson | ConvertFrom-Json
  $assistantText = $payload.last_assistant_message
  if ([string]::IsNullOrWhiteSpace($assistantText)) {
    exit 0
  }

  @{
    source = "claude"
    hook_event_name = "Stop"
    session_id = $payload.session_id
    cwd = $payload.cwd
    transcript_path = $payload.transcript_path
    assistant_response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js"
} catch {
  exit 0
}

exit 0
