$ErrorActionPreference = "Stop"

try {
  $inputJson = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }

  $payload = $inputJson | ConvertFrom-Json
  $assistantText = $payload.last_assistant_message
  if ([string]::IsNullOrWhiteSpace($assistantText)) { exit 0 }

  $normalizedJson = @{
    source = "claude"
    hook_event_name = "Stop"
    assistant_response = @{ text = $assistantText }
    session_id = $payload.session_id
    thread_id = $payload.thread_id
    thread_name = $payload.thread_name
    session_name = $payload.session_name
    cwd = $payload.cwd
    workspace = $payload.workspace
    project_dir = $payload.project_dir
  } | ConvertTo-Json -Depth 8

  $hookCommand = $env:AGENT_HOTLINE_HOOK_CMD
  if ([string]::IsNullOrWhiteSpace($hookCommand)) {
    $hookCommand = "node \"C:\\Users\\sushi\\Documents\\Github\\agent-hotline\\packages\\backend\\bin\\agent-hotline.js\" hook"
  }

  $normalizedJson | cmd.exe /d /s /c $hookCommand
} catch {
  exit 0
}

exit 0
