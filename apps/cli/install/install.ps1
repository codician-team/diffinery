# Installs the Diffinery CLI on Windows:
#
#   powershell -c "irm https://diffinery.com/install.ps1 | iex"
#
# The CLI goes in %USERPROFILE%\.diffinery (set DIFFINERY_INSTALL to change that), and its bin
# folder is added to your user PATH (DIFFINERY_NO_MODIFY_PATH=1 skips that). It runs on Node.js 22
# or later: the one on your PATH when it's new enough, otherwise a private copy of the Node.js LTS
# from nodejs.org, checked against its published SHA-256, in .diffinery\node.
# Run it again, or `diffinery upgrade`, to update. Served by Diffinery from apps/cli/install/.
# `irm | iex` runs this in your session: the block keeps its settings and variables out of it.
& {
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest is many times faster without its progress bar.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Server = if ($env:DIFFINERY_URL) { $env:DIFFINERY_URL } else { '__DIFFINERY_URL__' }
  if ($Server.StartsWith('__')) { $Server = 'https://diffinery.com' }
  $Server = $Server.TrimEnd('/')
  $Root = if ($env:DIFFINERY_INSTALL) { $env:DIFFINERY_INSTALL } else { Join-Path $HOME '.diffinery' }
  $Bin = Join-Path $Root 'bin'
  $Lib = Join-Path $Root 'lib'
  $Private = Join-Path $Root 'node\node.exe'
  $NodeLine = 24

  function Test-Node([string] $Exe) {
    try {
      & $Exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" *> $null
      return $LASTEXITCODE -eq 0
    } catch {
      return $false
    }
  }

  # 1. Node.js for the CLI to run on.
  $OwnNode = $false
  $SystemNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ((Test-Path $Private) -and (Test-Node $Private)) {
    $OwnNode = $true
  } elseif (-not ($SystemNode -and (Test-Node $SystemNode.Source))) {
    $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    Write-Host "Installing Node.js $NodeLine LTS for the CLI, from nodejs.org..."
    $Dist = "https://nodejs.org/dist/latest-v$NodeLine.x"
    $Sums = [string] (Invoke-WebRequest -UseBasicParsing "$Dist/SHASUMS256.txt").Content
    $Line = $Sums -split "`n" | Where-Object { $_ -match "^[0-9a-f]{64}  node-v[0-9.]+-win-$Arch\.zip$" } | Select-Object -First 1
    if (-not $Line) { throw "nodejs.org has no Node.js build for win-$Arch" }
    $Want, $File = $Line.Trim() -split '\s+'
    $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("diffinery-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $Tmp | Out-Null
    try {
      $Zip = Join-Path $Tmp $File
      Invoke-WebRequest -UseBasicParsing "$Dist/$File" -OutFile $Zip
      if ((Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower() -ne $Want) { throw "$File doesn't match its published SHA-256, so it wasn't installed" }
      Expand-Archive -Path $Zip -DestinationPath $Tmp
      $Dest = Join-Path $Root 'node'
      New-Item -ItemType Directory -Force -Path $Root | Out-Null
      if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
      Move-Item (Join-Path $Tmp ($File -replace '\.zip$', '')) $Dest
    } finally {
      Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
    }
    $OwnNode = $true
  }

  # 2. The CLI itself: one JavaScript file.
  New-Item -ItemType Directory -Force -Path $Bin, $Lib | Out-Null
  $Cli = Join-Path $Lib 'diffinery.mjs'
  $Download = "$Cli.download"
  Invoke-WebRequest -UseBasicParsing "$Server/-/cli/diffinery.mjs" -OutFile $Download
  if (-not ((Get-Content $Download -TotalCount 1) -like '#!/usr/bin/env node*')) {
    Remove-Item -Force $Download
    throw "$Server/-/cli/diffinery.mjs isn't the CLI"
  }
  Move-Item -Force $Download $Cli

  # 3. The diffinery command: the private Node.js when there is one, else the node on PATH.
  $Cmd = @(
    '@echo off',
    "rem The Diffinery CLI, installed from $Server/install.ps1. Update it with: diffinery upgrade",
    'setlocal',
    'set "DIFFINERY_NODE=node"',
    'if exist "%~dp0..\node\node.exe" set "DIFFINERY_NODE=%~dp0..\node\node.exe"',
    '"%DIFFINERY_NODE%" "%~dp0..\lib\diffinery.mjs" %*'
  ) -join "`r`n"
  Set-Content -Path (Join-Path $Bin 'diffinery.cmd') -Value $Cmd -Encoding ASCII
  $Version = & (Join-Path $Bin 'diffinery.cmd') --version
  if ($LASTEXITCODE -ne 0) { throw "the CLI was installed in $Root but doesn't start; run $Bin\diffinery.cmd --version to see why" }

  # 4. PATH, for new terminals and this one.
  $Note = $null
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($UserPath -split ';') -contains $Bin)) {
    if ($env:DIFFINERY_NO_MODIFY_PATH) {
      $Note = "Add $Bin to your PATH to run diffinery."
    } else {
      [Environment]::SetEnvironmentVariable('Path', ((@($UserPath, $Bin) | Where-Object { $_ }) -join ';'), 'User')
      $Note = "Added $Bin to your user PATH. Open a new terminal to use it everywhere."
    }
  }
  if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$Bin;$env:Path" }

  Write-Host "$([char]0x2713) $Version installed to $Bin\diffinery.cmd$(if ($OwnNode) { ' (with its own Node.js)' })" -ForegroundColor Green
  if ($Note) { Write-Host $Note }
  $Login = if ($Server -eq 'https://diffinery.com') { 'diffinery login' } else { "diffinery login --url $Server" }
  Write-Host ""
  Write-Host "Next, sign in through your browser:"
  Write-Host "  $Login"
}
