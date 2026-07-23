param(
    [switch]$Run,
    [switch]$SkipBundle,
    [switch]$Installer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Resolve-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @{ Command = 'py'; Args = @('-3') }
    }

    if (Get-Command python3 -ErrorAction SilentlyContinue) {
        return @{ Command = 'python3'; Args = @() }
    }

    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @{ Command = 'python'; Args = @() }
    }

    throw 'Python 3 is required to bundle the web assets.'
}

function Invoke-CommandChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $Command $($Arguments -join ' ')"
    }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust/Cargo is required. Install Rust with the MSVC toolchain before building.'
}

$python = Resolve-PythonCommand

if (-not $SkipBundle) {
    Write-Host 'Bundling web assets...'
    Invoke-CommandChecked -Command $python.Command -Arguments ($python.Args + @('.\scripts\bundle_web.py'))
}

Write-Host 'Building Windows client in release mode...'
Invoke-CommandChecked -Command 'cargo' -Arguments @('build', '--release', '--manifest-path', '.\apps\windows\Cargo.toml')

$sourceExe = Join-Path $RepoRoot 'apps\windows\target\release\zali_messenger_win.exe'
if (-not (Test-Path $sourceExe)) {
    throw "Expected executable not found: $sourceExe"
}

$distDir = Join-Path $RepoRoot 'dist\windows'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$distExe = Join-Path $distDir 'ZaliMessenger.exe'
Copy-Item $sourceExe $distExe -Force

Write-Host "Windows build ready: $distExe"
Write-Host 'Notes:'
Write-Host '  - Install the Microsoft Edge WebView2 Runtime on the target machine.'
Write-Host '  - Start the server before launching the client.'

if ($Installer) {
    $iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if (-not $iscc) {
        throw 'Inno Setup (ISCC.exe) not found on PATH. Install it from https://jrsoftware.org/isinfo.php'
    }

    $cargoTomlPath = Join-Path $RepoRoot 'apps\windows\Cargo.toml'
    $versionMatch = Select-String -Path $cargoTomlPath -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $versionMatch) {
        throw "Could not read version from $cargoTomlPath"
    }
    $version = $versionMatch.Matches[0].Groups[1].Value

    Write-Host "Building installer for version $version..."
    $issPath = Join-Path $RepoRoot 'apps\windows\installer\ZaliMessenger.iss'
    Invoke-CommandChecked -Command $iscc.Source -Arguments @("/DMyAppVersion=$version", $issPath)

    $installerExe = Join-Path $RepoRoot "dist\windows\installer\ZaliMessengerSetup-$version.exe"
    Write-Host "Installer ready: $installerExe"
}

if ($Run) {
    Write-Host 'Launching Windows client...'
    & $distExe
}
