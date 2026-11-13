param(
    [string]$Python = "python",
    [int]$Port = 18777,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverArgs = @((Join-Path $projectRoot "server.py"), "--port", "$Port")
if ($NoBrowser) { $serverArgs += "--no-browser" }
& $Python @serverArgs
exit $LASTEXITCODE
