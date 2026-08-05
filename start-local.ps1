$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
  # Older hosts may not allow changing console encoding; startup can continue.
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

function Read-DotEnvFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $lineNumber = 0
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $lineNumber += 1
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) {
      continue
    }

    if ($line.StartsWith('export ')) {
      $line = $line.Substring(7).TrimStart()
    }

    $equalsIndex = $line.IndexOf('=')
    if ($equalsIndex -le 0) {
      Write-Warning "Skip $Path line ${lineNumber}: expected KEY=VALUE."
      continue
    }

    $name = $line.Substring(0, $equalsIndex).Trim()
    $value = $line.Substring($equalsIndex + 1).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      Write-Warning "Skip $Path line ${lineNumber}: invalid environment variable name."
      continue
    }

    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Test-AlphaNumericSecret {
  param([string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrEmpty($value)) {
    return
  }

  if ($value -notmatch '^[A-Za-z0-9]{6,256}$') {
    Write-Warning "$Name must be 6-256 letters or digits; startup may reject this value."
  }
}

$envPath = Join-Path $Root '.env.local'
$legacyEnvPath = Join-Path $Root '.env'
$exampleEnvPath = Join-Path $Root '.env.example'

if (-not (Test-Path -LiteralPath $envPath) -and (Test-Path -LiteralPath $exampleEnvPath)) {
  Copy-Item -LiteralPath $exampleEnvPath -Destination $envPath -Force
  Write-Host "Created .env.local from .env.example"
  Write-Host "Edit .env.local to add admin password, client token, OpenCode keys, and proxies."
}

if (Test-Path -LiteralPath $envPath) {
  Write-Host "Loading environment variables from .env.local"
  Read-DotEnvFile -Path $envPath
} elseif (Test-Path -LiteralPath $legacyEnvPath) {
  Write-Host "Loading environment variables from .env"
  Read-DotEnvFile -Path $legacyEnvPath
} else {
  Write-Host "No .env.local or .env found; using defaults or first-run setup in the admin panel."
}

Test-AlphaNumericSecret -Name 'OPENCODE_BRIDGE_ADMIN_PASSWORD'
Test-AlphaNumericSecret -Name 'OPENCODE_BRIDGE_CLIENT_TOKEN'

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error "Node.js was not found. Install Node.js 22.20+ or 24.11+ and try again."
}

$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  Write-Error "npm was not found. Reinstall Node.js 22.20+ or 24.11+, or fix PATH."
}

$nodeVersionText = (& node -p "process.versions.node").Trim()
$nodeParts = $nodeVersionText.Split('.') | ForEach-Object { [int]$_ }
if (
  $nodeParts[0] -ge 25 -or
  $nodeParts[0] -lt 22 -or
  $nodeParts[0] -eq 23 -or
  ($nodeParts[0] -eq 22 -and $nodeParts[1] -lt 20) -or
  ($nodeParts[0] -eq 24 -and $nodeParts[1] -lt 11)
) {
  Write-Warning "Current Node.js version is $nodeVersionText; recommended versions are Node.js 22.20+ or 24.11+."
}

if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
  Write-Host "node_modules not found; restoring locked dependencies with npm ci"
  & npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$hostName = if ($env:HOST) { $env:HOST } else { '127.0.0.1' }
$portNumber = if ($env:PORT) { $env:PORT } else { '8787' }
$displayHost = if ($hostName -eq '0.0.0.0') { '127.0.0.1' } else { $hostName }

Write-Host ""
Write-Host "Starting OpenCode Protocol Bridge:"
Write-Host "  Admin panel: http://${displayHost}:$portNumber"
Write-Host "  Zen Base URL: http://${displayHost}:$portNumber/zen/v1"
Write-Host "  Go  Base URL: http://${displayHost}:$portNumber/go/v1"
Write-Host ""
Write-Host "Press Ctrl+C to stop the service."
Write-Host ""

& npm start
exit $LASTEXITCODE
