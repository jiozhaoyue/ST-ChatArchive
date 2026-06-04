param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$Port = 8123,
  [string]$Mount = '/chat-archive-pack.git'
)

$node = (Get-Command node).Source
$script = Join-Path $PSScriptRoot 'local-git-http-server.mjs'

Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList @($script, '--repo', $Repo, '--port', $Port, '--mount', $Mount)
Write-Host "Started local Git server at http://127.0.0.1:$Port$Mount"
