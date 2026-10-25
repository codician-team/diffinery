# Installs the Diffinery extension into the editors built on VS Code on this computer (Windows):
#
#   powershell -c "irm https://diffinery.com/install-editor.ps1 | iex"
#
# Set $env:DIFFINERY_EDITORS = "cursor" (names: code, code-insiders, cursor, windsurf, codium) to choose.
# Each editor's command-line tool is used from PATH, or from its usual install folder. The .vsix comes
# from the server that served this script and is checked against the SHA-256 it publishes. The
# extension updates itself afterwards. Served by Diffinery from apps/vscode/install/.
$ErrorActionPreference = "Stop"
$server = if ($env:DIFFINERY_URL) { $env:DIFFINERY_URL } else { "__DIFFINERY_URL__" }
if ($server.StartsWith("__")) { $server = "https://diffinery.com" }
$server = $server.TrimEnd("/")

$known = @(
  @{ Name = "code"; Label = "VS Code"; Paths = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd") },
  @{ Name = "code-insiders"; Label = "VS Code Insiders"; Paths = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd") },
  @{ Name = "cursor"; Label = "Cursor"; Paths = @("$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd") },
  @{ Name = "windsurf"; Label = "Windsurf"; Paths = @("$env:LOCALAPPDATA\Programs\Windsurf\bin\windsurf.cmd") },
  @{ Name = "codium"; Label = "VSCodium"; Paths = @("$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd", "$env:ProgramFiles\VSCodium\bin\codium.cmd") }
)
$wanted = if ($env:DIFFINERY_EDITORS) { $env:DIFFINERY_EDITORS -split "[ ,]+" } else { @() }

$meta = Invoke-RestMethod "$server/-/vscode/version.json"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("diffinery-" + [Guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $vsix = Join-Path $tmp "diffinery-$($meta.version).vsix"
  Invoke-WebRequest "$server/-/vscode/diffinery-$($meta.version).vsix" -OutFile $vsix -UseBasicParsing
  if ((Get-FileHash $vsix -Algorithm SHA256).Hash.ToLower() -ne $meta.sha256) { throw "The download didn't match the published SHA-256; nothing was installed." }
  # A self-hosted Diffinery: leave its address where the extension looks when it starts (src/servers.ts), and it asks
  # whether to use it. Editors' command-line tools can't change a setting, and their settings files are JSON with
  # comments, so this doesn't edit them. Written before installing, since a running editor starts a new extension at once.
  $conf = if ($env:XDG_CONFIG_HOME -and [IO.Path]::IsPathRooted($env:XDG_CONFIG_HOME)) { $env:XDG_CONFIG_HOME } else { Join-Path $(if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }) ".config" }
  $hintFile = Join-Path $conf "diffinery\editor-server"
  $hint = $false
  if ($server -ne "https://diffinery.com") {
    try {
      New-Item -ItemType Directory -Force (Split-Path $hintFile) | Out-Null
      [IO.File]::WriteAllText($hintFile, "$server`n")
      $hint = $true
    } catch {}
  } else {
    Remove-Item -Force $hintFile -ErrorAction SilentlyContinue
  }

  $installed = 0
  foreach ($e in $known) {
    if ($wanted.Count -gt 0 -and $wanted -notcontains $e.Name) { continue }
    $cli = (Get-Command "$($e.Name).cmd" -ErrorAction SilentlyContinue).Source
    if (-not $cli) { $cli = $e.Paths | Where-Object { Test-Path $_ } | Select-Object -First 1 }
    if (-not $cli) {
      if ($wanted.Count -gt 0) { Write-Host "x $($e.Label): its command-line tool ($($e.Name)) wasn't found" }
      continue
    }
    & $cli --install-extension $vsix --force | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "v $($e.Label): Diffinery extension $($meta.version) installed"; $installed++ }
    else { Write-Host "x $($e.Label): installing failed" }
  }
  if ($installed -eq 0) {
    Write-Host "No editor took the extension. Install it from the editor instead: Extensions > ... > Install from VSIX..."
    Write-Host "with $server/-/vscode/diffinery.vsix, or see $server/docs/repositories/clone-in-your-editor"
    exit 1
  }
  Write-Host ""
  if ($server -ne "https://diffinery.com") {
    if ($hint) {
      Write-Host "This Diffinery is $server. When the editor starts, the extension asks to use it: choose Use $($server -replace '^[a-z]+://', '')."
      Write-Host "If it doesn't ask, run Diffinery: Use Another Server... from the Command Palette and enter $server."
    } else {
      Write-Host "This Diffinery is $server`: in the editor, run Diffinery: Use Another Server... from the Command Palette and enter it."
    }
  }
  Write-Host "Next: in the editor, run Git: Clone and pick Clone from Diffinery. ($server/docs/repositories/clone-in-your-editor)"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
