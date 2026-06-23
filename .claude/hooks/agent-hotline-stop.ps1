$ErrorActionPreference = "Stop"

try {
  $inputJson = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($inputJson)) {
    exit 0
  }

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
    assistant_response = @{
      text = $assistantText
    }
  } | ConvertTo-Json -Depth 8 | node "C:\Users\sushi\Documents\Github\agent-hotline\packages\backend\bin\agent-hotline-hook.js"
} catch {
  exit 0
}

exit 0
